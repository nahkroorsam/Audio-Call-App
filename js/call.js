// ============================================================
// WebRTC Audio Mesh + Supabase Realtime Signaling
// Supports up to 10 participants, push-to-talk, mute
// ============================================================

import { supabase } from './supabaseClient.js';

const MAX_PARTICIPANTS = 10;
const ICE_SERVERS = [
  { urls: 'stun:stun.l.google.com:19302' },
  { urls: 'stun:stun1.l.google.com:19302' }
];

export class AudioCall {
  constructor({ roomCode, user, onStatus, onParticipants, onError }) {
    this.roomCode = roomCode;
    this.user = user;                 // { id, email }
    this.onStatus = onStatus || (() => {});
    this.onParticipants = onParticipants || (() => {});
    this.onError = onError || (() => {});

    this.localStream = null;
    this.peers = {};                  // peerId → { pc, stream, email }
    this.channel = null;
    this.isMuted = true;              // start muted (PTT default)
    this.isPttMode = true;
    this.myPeerId = user.id;          // use Supabase user UUID
    this.joined = false;
  }

  // -------------------- Public API --------------------

  async join() {
    try {
      this.onStatus('Requesting microphone…');
      this.localStream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true
        },
        video: false
      });

      // Start muted
      this.localStream.getAudioTracks().forEach(t => (t.enabled = false));
      this.isMuted = true;

      this.onStatus('Connecting to room…');

      // Realtime channel for this room
      this.channel = supabase.channel(`room:${this.roomCode}`, {
        config: {
          presence: { key: this.myPeerId },
          broadcast: { self: false }
        }
      });

      // Presence – who is in the room
      this.channel.on('presence', { event: 'sync' }, () => {
        this._handlePresenceSync();
      });

      this.channel.on('presence', { event: 'join' }, ({ key, newPresences }) => {
        // new peer joined – we will create offer to them if needed
      });

      this.channel.on('presence', { event: 'leave' }, ({ key }) => {
        this._removePeer(key);
      });

      // Signaling messages
      this.channel.on('broadcast', { event: 'signal' }, ({ payload }) => {
        this._handleSignal(payload);
      });

      const status = await this.channel.subscribe(async (status) => {
        if (status === 'SUBSCRIBED') {
          // Track ourselves in presence
          await this.channel.track({
            peerId: this.myPeerId,
            email: this.user.email,
            joinedAt: Date.now()
          });
          this.joined = true;
          this.onStatus('Connected');
          this._updateParticipantsUI();
        }
      });

      if (status === 'CHANNEL_ERROR') {
        throw new Error('Failed to join room channel');
      }
    } catch (err) {
      console.error(err);
      this.onError(err.message || 'Could not join call');
      throw err;
    }
  }

  async leave() {
    // Close all peer connections
    Object.keys(this.peers).forEach(id => this._removePeer(id));

    if (this.localStream) {
      this.localStream.getTracks().forEach(t => t.stop());
      this.localStream = null;
    }

    if (this.channel) {
      await this.channel.untrack();
      await supabase.removeChannel(this.channel);
      this.channel = null;
    }

    this.joined = false;
    this.onStatus('Left call');
    this.onParticipants([]);
  }

  // Mute / Unmute
  setMuted(muted) {
    this.isMuted = muted;
    if (this.localStream) {
      this.localStream.getAudioTracks().forEach(t => (t.enabled = !muted));
    }
    this._updateParticipantsUI();
  }

  toggleMute() {
    this.setMuted(!this.isMuted);
    // If user opens mic permanently, disable strict PTT
    if (!this.isMuted) {
      this.isPttMode = false;
    }
    return this.isMuted;
  }

  // Push-to-Talk
  pttDown() {
    if (!this.localStream || !this.isPttMode) return;
    this.localStream.getAudioTracks().forEach(t => (t.enabled = true));
    this.isMuted = false;
    this._updateParticipantsUI();
  }

  pttUp() {
    if (!this.localStream || !this.isPttMode) return;
    this.localStream.getAudioTracks().forEach(t => (t.enabled = false));
    this.isMuted = true;
    this._updateParticipantsUI();
  }

  // -------------------- Presence --------------------

  _handlePresenceSync() {
    if (!this.channel) return;
    const state = this.channel.presenceState();
    const remoteIds = new Set();

    Object.values(state).forEach(presences => {
      presences.forEach(p => {
        if (p.peerId !== this.myPeerId) {
          remoteIds.add(p.peerId);
          // Store email if we don't have it yet
          if (!this.peers[p.peerId]) {
            this.peers[p.peerId] = { email: p.email, pc: null, stream: null };
          } else {
            this.peers[p.peerId].email = p.email;
          }
        }
      });
    });

    // Remove peers that left
    Object.keys(this.peers).forEach(id => {
      if (!remoteIds.has(id)) this._removePeer(id);
    });

    // Create connections to new peers (we initiate if our ID is "smaller"
    // to avoid glare – simple deterministic rule)
    remoteIds.forEach(remoteId => {
      if (!this.peers[remoteId]?.pc) {
        if (this.myPeerId < remoteId) {
          this._createOffer(remoteId);
        }
      }
    });

    // Enforce max participants
    const total = remoteIds.size + 1;
    if (total > MAX_PARTICIPANTS) {
      this.onError(`Room is full (max ${MAX_PARTICIPANTS})`);
      this.leave();
      return;
    }

    this._updateParticipantsUI();
  }

  // -------------------- Signaling --------------------

  async _sendSignal(payload) {
    if (!this.channel) return;
    await this.channel.send({
      type: 'broadcast',
      event: 'signal',
      payload: { ...payload, from: this.myPeerId }
    });
  }

  async _handleSignal(msg) {
    if (msg.from === this.myPeerId) return;
    if (msg.to && msg.to !== this.myPeerId) return; // not for us

    switch (msg.type) {
      case 'offer':
        await this._handleOffer(msg.from, msg.sdp);
        break;
      case 'answer':
        await this._handleAnswer(msg.from, msg.sdp);
        break;
      case 'ice':
        await this._handleIce(msg.from, msg.candidate);
        break;
    }
  }

  // -------------------- WebRTC helpers --------------------

  _createPeerConnection(remoteId) {
    const pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });

    // Add local audio tracks
    if (this.localStream) {
      this.localStream.getTracks().forEach(track => {
        pc.addTrack(track, this.localStream);
      });
    }

    // ICE candidates
    pc.onicecandidate = (ev) => {
      if (ev.candidate) {
        this._sendSignal({
          type: 'ice',
          to: remoteId,
          candidate: ev.candidate
        });
      }
    };

    // Remote stream
    pc.ontrack = (ev) => {
      const stream = ev.streams[0];
      if (!this.peers[remoteId]) {
        this.peers[remoteId] = { email: 'User', pc, stream };
      } else {
        this.peers[remoteId].stream = stream;
        this.peers[remoteId].pc = pc;
      }

      // Attach to audio element
      let audio = document.getElementById(`audio-${remoteId}`);
      if (!audio) {
        audio = document.createElement('audio');
        audio.id = `audio-${remoteId}`;
        audio.autoplay = true;
        audio.playsInline = true;
        document.body.appendChild(audio);
      }
      audio.srcObject = stream;
      this._updateParticipantsUI();
    };

    pc.onconnectionstatechange = () => {
      if (['failed', 'disconnected', 'closed'].includes(pc.connectionState)) {
        this._removePeer(remoteId);
      }
    };

    return pc;
  }

  async _createOffer(remoteId) {
    if (this.peers[remoteId]?.pc) return;

    const pc = this._createPeerConnection(remoteId);
    this.peers[remoteId] = {
      ...(this.peers[remoteId] || {}),
      pc,
      email: this.peers[remoteId]?.email || 'User'
    };

    try {
      const offer = await pc.createOffer({ offerToReceiveAudio: true });
      await pc.setLocalDescription(offer);
      await this._sendSignal({
        type: 'offer',
        to: remoteId,
        sdp: pc.localDescription
      });
    } catch (err) {
      console.error('createOffer error', err);
      this._removePeer(remoteId);
    }
  }

  async _handleOffer(from, sdp) {
    let pc = this.peers[from]?.pc;
    if (!pc) {
      pc = this._createPeerConnection(from);
      this.peers[from] = {
        ...(this.peers[from] || {}),
        pc,
        email: this.peers[from]?.email || 'User'
      };
    }

    try {
      await pc.setRemoteDescription(new RTCSessionDescription(sdp));
      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);
      await this._sendSignal({
        type: 'answer',
        to: from,
        sdp: pc.localDescription
      });
    } catch (err) {
      console.error('handleOffer error', err);
    }
  }

  async _handleAnswer(from, sdp) {
    const pc = this.peers[from]?.pc;
    if (!pc) return;
    try {
      await pc.setRemoteDescription(new RTCSessionDescription(sdp));
    } catch (err) {
      console.error('handleAnswer error', err);
    }
  }

  async _handleIce(from, candidate) {
    const pc = this.peers[from]?.pc;
    if (!pc || !candidate) return;
    try {
      await pc.addIceCandidate(new RTCIceCandidate(candidate));
    } catch (err) {
      // ignore late candidates
    }
  }

  _removePeer(id) {
    const peer = this.peers[id];
    if (peer?.pc) {
      peer.pc.close();
    }
    const audio = document.getElementById(`audio-${id}`);
    if (audio) audio.remove();
    delete this.peers[id];
    this._updateParticipantsUI();
  }

  _updateParticipantsUI() {
    const list = [
      {
        id: this.myPeerId,
        email: this.user.email,
        isMe: true,
        muted: this.isMuted
      },
      ...Object.entries(this.peers).map(([id, p]) => ({
        id,
        email: p.email || 'User',
        isMe: false,
        muted: false
      }))
    ];
    this.onParticipants(list);
  }
}

// Helper: create a short random room code
export function generateRoomCode(length = 8) {
  const chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
  let code = '';
  for (let i = 0; i < length; i++) {
    code += chars[Math.floor(Math.random() * chars.length)];
  }
  return code;
}

// ============================================================
// Main application logic
// ============================================================

import {
  getSession,
  getUser,
  signUp,
  signIn,
  signInWithGoogle,
  signOut,
  onAuthStateChange
} from './auth.js';
import { AudioCall, generateRoomCode } from './call.js';
import { supabase } from './supabaseClient.js';

// -------------------- DOM refs --------------------
const authScreen = document.getElementById('auth-screen');
const dashScreen = document.getElementById('dashboard-screen');
const callScreen = document.getElementById('call-screen');

const loginForm = document.getElementById('login-form');
const signupForm = document.getElementById('signup-form');
const errorAuth = document.getElementById('error-auth');
const successAuth = document.getElementById('success-auth');
const errorDash = document.getElementById('error-dash');

const currentUserEmail = document.getElementById('current-user-email');
const roomLinkBox = document.getElementById('room-link');
const linkSection = document.getElementById('link-section');
const joinRoomInput = document.getElementById('join-room-id');

const callStatus = document.getElementById('call-status');
const roomDisplay = document.getElementById('room-display');
const participantsList = document.getElementById('participants-list');
const muteBtn = document.getElementById('mute-btn');
const pttBtn = document.getElementById('ptt-btn');
const leaveBtn = document.getElementById('leave-btn');
const pttHint = document.getElementById('ptt-hint');

let currentUser = null;
let activeCall = null;
let currentRoomCode = null;

// -------------------- Helpers --------------------
function show(el) { el.classList.remove('hidden'); }
function hide(el) { el.classList.add('hidden'); }

function showError(el, msg) {
  el.textContent = msg;
  show(el);
  setTimeout(() => hide(el), 6000);
}

function showSuccess(el, msg) {
  el.textContent = msg;
  show(el);
  setTimeout(() => hide(el), 5000);
}

function showAuth() {
  hide(dashScreen); hide(callScreen); show(authScreen);
}

function showDashboard() {
  hide(authScreen); hide(callScreen); show(dashScreen);
  currentUserEmail.textContent = currentUser?.email || '';
  hide(linkSection);
  joinRoomInput.value = '';
}

function showCallScreen() {
  hide(authScreen); hide(dashScreen); show(callScreen);
}

// -------------------- Tabs --------------------
document.querySelectorAll('.tab').forEach(tab => {
  tab.addEventListener('click', () => {
    document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
    tab.classList.add('active');
    if (tab.dataset.tab === 'login') {
      show(loginForm); hide(signupForm);
    } else {
      hide(loginForm); show(signupForm);
    }
  });
});

// -------------------- Auth forms --------------------
signupForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  const email = document.getElementById('signup-email').value.trim().toLowerCase();
  const pass = document.getElementById('signup-password').value;
  const confirm = document.getElementById('signup-confirm').value;

  if (pass.length < 6) {
    showError(errorAuth, 'Password must be at least 6 characters.');
    return;
  }
  if (pass !== confirm) {
    showError(errorAuth, 'Passwords do not match.');
    return;
  }

  const { data, error } = await signUp(email, pass);
  if (error) {
    showError(errorAuth, error.message);
    return;
  }

  // Supabase sends confirmation email when "Confirm email" is enabled
  showSuccess(
    successAuth,
    'Account created! Check your email (including spam) for the confirmation link, then log in.'
  );
  setTimeout(() => {
    document.querySelector('.tab[data-tab="login"]').click();
    document.getElementById('login-email').value = email;
  }, 2000);
});

loginForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  const email = document.getElementById('login-email').value.trim().toLowerCase();
  const pass = document.getElementById('login-password').value;

  const { data, error } = await signIn(email, pass);
  if (error) {
    showError(errorAuth, error.message);
    return;
  }
  // onAuthStateChange will handle UI
});

document.getElementById('google-btn')?.addEventListener('click', async () => {
  const { error } = await signInWithGoogle();
  if (error) showError(errorAuth, error.message);
});

document.getElementById('logout-btn').addEventListener('click', async () => {
  if (activeCall) await activeCall.leave();
  await signOut();
  currentUser = null;
  showAuth();
});

// -------------------- Dashboard – create / join --------------------
document.getElementById('create-call-btn').addEventListener('click', async () => {
  currentRoomCode = generateRoomCode(8);

  // Optional: persist room in Supabase
  try {
    await supabase.from('rooms').insert({
      code: currentRoomCode,
      created_by: currentUser.id
    });
  } catch (e) {
    // non-fatal – channel still works without the row
    console.warn('Could not insert room row', e);
  }

  const link = `${location.origin}${location.pathname}?room=${currentRoomCode}`;
  roomLinkBox.textContent = link;
  show(linkSection);
});

document.getElementById('copy-link-btn').addEventListener('click', () => {
  const text = roomLinkBox.textContent;
  navigator.clipboard.writeText(text).then(() => {
    const btn = document.getElementById('copy-link-btn');
    btn.textContent = 'Copied!';
    setTimeout(() => (btn.textContent = 'Copy Link'), 2000);
  });
});

document.getElementById('join-own-btn').addEventListener('click', () => {
  if (currentRoomCode) startCall(currentRoomCode);
});

document.getElementById('join-call-btn').addEventListener('click', () => {
  let val = joinRoomInput.value.trim();
  if (!val) {
    showError(errorDash, 'Enter a room code or paste the full link.');
    return;
  }
  // Extract code from full URL if needed
  try {
    const url = new URL(val);
    val = url.searchParams.get('room') || val;
  } catch {}
  if (val.includes('room=')) {
    val = val.split('room=')[1].split('&')[0];
  }
  currentRoomCode = val;
  startCall(currentRoomCode);
});

// -------------------- Call --------------------
async function startCall(roomCode) {
  if (!currentUser) return;

  roomDisplay.textContent = roomCode;
  participantsList.innerHTML = '';
  callStatus.className = 'status-badge connecting';
  callStatus.innerHTML = '<span>●</span> Connecting…';
  showCallScreen();

  // Clean previous
  if (activeCall) {
    await activeCall.leave();
    activeCall = null;
  }

  activeCall = new AudioCall({
    roomCode,
    user: { id: currentUser.id, email: currentUser.email },
    onStatus: (text) => {
      callStatus.innerHTML = `<span>●</span> ${text}`;
      callStatus.className =
        text === 'Connected' ? 'status-badge' : 'status-badge connecting';
    },
    onParticipants: (list) => {
      participantsList.innerHTML = '';
      list.forEach(p => {
        const div = document.createElement('div');
        div.className = 'participant' + (p.isMe ? ' me' : '');
        div.id = 'p-' + p.id;
        div.innerHTML = `
          <div class="name">${p.isMe ? 'You' : (p.email || 'User')}</div>
          <div class="state">${p.isMe ? (p.muted ? 'Muted' : 'Speaking') : 'Connected'}</div>
        `;
        participantsList.appendChild(div);
      });
    },
    onError: (msg) => {
      alert(msg);
      leaveCall();
    }
  });

  try {
    await activeCall.join();
    // Reset PTT state
    activeCall.isPttMode = true;
    activeCall.setMuted(true);
    updateMuteUI(true);
    pttHint.textContent = 'Push-to-Talk is ON · Hold the green button (or Space) to speak';
  } catch (err) {
    // already handled by onError
  }
}

function updateMuteUI(muted) {
  if (muted) {
    muteBtn.classList.add('active');
    muteBtn.textContent = '🔇';
  } else {
    muteBtn.classList.remove('active');
    muteBtn.textContent = '🎤';
  }
}

muteBtn.addEventListener('click', () => {
  if (!activeCall) return;
  const muted = activeCall.toggleMute();
  updateMuteUI(muted);
  if (!muted) {
    pttHint.textContent = 'Microphone open · Click mute or hold PTT to control';
  }
});

// Push-to-Talk
function pttDown() {
  if (!activeCall) return;
  activeCall.pttDown();
  pttBtn.classList.add('pressed');
  updateMuteUI(false);
}
function pttUp() {
  if (!activeCall) return;
  activeCall.pttUp();
  pttBtn.classList.remove('pressed');
  updateMuteUI(true);
}

pttBtn.addEventListener('mousedown', pttDown);
pttBtn.addEventListener('mouseup', pttUp);
pttBtn.addEventListener('mouseleave', pttUp);
pttBtn.addEventListener('touchstart', (e) => { e.preventDefault(); pttDown(); });
pttBtn.addEventListener('touchend', (e) => { e.preventDefault(); pttUp(); });

document.addEventListener('keydown', (e) => {
  if (e.code === 'Space' && !callScreen.classList.contains('hidden')) {
    e.preventDefault();
    pttDown();
  }
});
document.addEventListener('keyup', (e) => {
  if (e.code === 'Space') {
    e.preventDefault();
    pttUp();
  }
});

leaveBtn.addEventListener('click', leaveCall);

async function leaveCall() {
  if (activeCall) {
    await activeCall.leave();
    activeCall = null;
  }
  // remove leftover audio elements
  document.querySelectorAll('audio[id^="audio-"]').forEach(a => a.remove());
  currentRoomCode = null;
  showDashboard();
}

// -------------------- Auth state & init --------------------
onAuthStateChange(async (event, session) => {
  if (session?.user) {
    currentUser = session.user;
    showDashboard();

    // Auto-join if ?room= is present
    const params = new URLSearchParams(location.search);
    const room = params.get('room');
    if (room && event === 'SIGNED_IN') {
      // small delay so UI is ready
      setTimeout(() => startCall(room), 300);
    }
  } else {
    currentUser = null;
    if (activeCall) await activeCall.leave();
    showAuth();
  }
});

// Initial load
(async () => {
  const session = await getSession();
  if (session?.user) {
    currentUser = session.user;
    showDashboard();

    const params = new URLSearchParams(location.search);
    const room = params.get('room');
    if (room) {
      setTimeout(() => startCall(room), 400);
    }
  } else {
    showAuth();
    // Pre-fill join box if room in URL (user still needs to login)
    const params = new URLSearchParams(location.search);
    const room = params.get('room');
    if (room) joinRoomInput.value = room;
  }
})();

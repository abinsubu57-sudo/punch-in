'use strict';
// ══ STATE ══
let currentUser         = null;
let isRunning           = false, isPaused = false, autoGeopaused = false;
let startTS             = null,  pausedMs = 0;
let sessionStart        = null,  curEvents = [];
let workZone            = null;
let watchId             = null,  insideZone = null;
let timerInterval       = null;
let weekOffset          = 0;
let wakeLock            = null;
let toastTmr            = null;
let geoFallbackInterval = null;

const TARGET_MS       = 8 * 3600000; // 8 hours
const ACC_CAP         = 15;   // max bonus metres added to zone radius for GPS drift
const ACCURACY_REJECT = 80;   // ignore fixes worse than this (cell-tower/WiFi noise)

// ══ BOOT ══
(async () => {
  await DB.open();
  const saved = Auth.load();
  if (saved) { currentUser = saved; await enterApp(); }
})();

// ══ SERVICE WORKER MESSAGING ══
// Sends a message to the active SW so it can show lock-screen notifications.
function swPost(msg) {
  if (!navigator.serviceWorker || !navigator.serviceWorker.controller) return;
  navigator.serviceWorker.controller.postMessage(msg);
}

// Request notification permission once — needed for SW notifications to show.
async function requestNotificationPermission() {
  if (!('Notification' in window)) return;
  if (Notification.permission === 'granted') return;
  if (Notification.permission === 'denied') return;
  const result = await Notification.requestPermission();
  if (result === 'granted') showToast('🔔 Lock-screen alerts enabled');
}

// ══ AUTH ══
function switchAuthTab(t) {
  document.getElementById('loginForm').style.display    = t === 'login'    ? 'block' : 'none';
  document.getElementById('registerForm').style.display = t === 'register' ? 'block' : 'none';
  document.getElementById('tabLogin').classList.toggle('active',    t === 'login');
  document.getElementById('tabRegister').classList.toggle('active', t === 'register');
}

async function doLogin() {
  const u = document.getElementById('loginUser').value.trim();
  const p = document.getElementById('loginPass').value;
  const e = document.getElementById('loginError');
  e.textContent = '';
  if (!u || !p) { e.textContent = 'Please fill in all fields.'; return; }
  try {
    const user = await Auth.login(u, p);
    Auth.save(user);
    currentUser = { username: user.username, name: user.name };
    await enterApp();
  } catch (err) { e.textContent = err.message; }
}

async function doRegister() {
  const name  = document.getElementById('regName').value.trim();
  const uname = document.getElementById('regUser').value.trim();
  const p1    = document.getElementById('regPass').value;
  const p2    = document.getElementById('regPass2').value;
  const e     = document.getElementById('regError');
  e.textContent = '';
  if (!name || !uname || !p1) { e.textContent = 'Please fill in all fields.'; return; }
  if (p1 !== p2) { e.textContent = 'Passwords do not match.'; return; }
  try {
    await Auth.register(name, uname, p1);
    Auth.save({ username: uname.toLowerCase().trim(), name });
    currentUser = { username: uname.toLowerCase().trim(), name };
    await enterApp();
  } catch (err) { e.textContent = err.message; }
}

function doLogout() {
  confirmModal('Sign Out', 'Are you sure you want to sign out?', async () => {
    await saveTimer();
    stopWatch();
    clearInterval(timerInterval);
    Auth.clear();
    currentUser = null;
    ['loginUser','loginPass','regName','regUser','regPass','regPass2'].forEach(id => {
      document.getElementById(id).value = '';
    });
    document.getElementById('authScreen').classList.add('active');
    document.getElementById('appScreen').classList.remove('active');
  });
}

// ══ ENTER APP ══
async function enterApp() {
  document.getElementById('authScreen').classList.remove('active');
  document.getElementById('appScreen').classList.add('active');
  setGreeting();
  workZone = await DB.get('zones', currentUser.username) || null;
  updateZoneDisplay();
  await restoreTimer();
  await refreshStats();
  updateDateLabel();
  if (workZone) requestGeoSilent();
  requestNotificationPermission();
  showPage('track');
}

function setGreeting() {
  const h = new Date().getHours();
  const g = h < 12 ? 'Good morning' : h < 17 ? 'Good afternoon' : 'Good evening';
  document.getElementById('topGreeting').textContent = g;
  document.getElementById('topName').textContent = currentUser.name;
}

function updateDateLabel() {
  document.getElementById('timerDate').textContent =
    new Date().toLocaleDateString([], { weekday:'long', month:'long', day:'numeric' });
}
setInterval(updateDateLabel, 60000);

// ══ NAVIGATION ══
function showPage(name) {
  document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));
  document.querySelectorAll('.nav-tab').forEach(t => t.classList.remove('active'));
  document.getElementById('page' + name[0].toUpperCase() + name.slice(1)).classList.add('active');
  document.querySelector(`.nav-tab[data-page="${name}"]`).classList.add('active');
  if (name === 'report') renderReport();
  if (name === 'stats')  renderStats();
}

// ══ TIMER ══
async function startTimer() {
  if (!workZone) { showToast('⚠ Set your work zone first'); showPage('settings'); return; }
  if (insideZone === false) { showToast('⚠ You are outside the work zone'); return; }

  if (isPaused || autoGeopaused) {
    curEvents.push({ type:'break-in', time:new Date().toISOString(), note: autoGeopaused ? 'Auto (returned)' : 'Manual resume' });
    startTS = Date.now(); isRunning = true; isPaused = false; autoGeopaused = false;
    timerInterval = setInterval(tick, 500);
    setUI('running'); await saveTimer(); showToast('▶ Break ended');
  } else {
    startTS = Date.now(); pausedMs = 0; sessionStart = new Date(); curEvents = [];
    curEvents.push({ type:'punch-in', time: sessionStart.toISOString(), note:'' });
    isRunning = true;
    timerInterval = setInterval(tick, 500);
    setUI('running');
    document.getElementById('punchDetails').style.display = 'block';
    document.getElementById('punchInTime').textContent =
      sessionStart.toLocaleTimeString([], { hour:'2-digit', minute:'2-digit' });
    await saveTimer(); showToast('✅ Clocked in!'); doWakeLock();
  }
  updatePunchDetails();
}

async function manualBreak() {
  if (!isRunning) return;
  curEvents.push({ type:'break-out', time:new Date().toISOString(), note:'Manual break' });
  doPause(false); await saveTimer(); showToast('⏸ Break started');
}

function doPause(byGeo) {
  clearInterval(timerInterval);
  pausedMs += Date.now() - startTS;
  isRunning = false;
  if (byGeo) {
    autoGeopaused = true; isPaused = false;
    curEvents.push({ type:'geo-out', time:new Date().toISOString(), note:'Left work zone' });
    setUI('outside');
  } else {
    isPaused = true; autoGeopaused = false;
    setUI('paused');
  }
  saveTimer();
}

async function stopTimer() {
  if (!isRunning && !isPaused && !autoGeopaused) return;
  clearInterval(timerInterval);
  const totalMs = pausedMs + (isRunning ? Date.now() - startTS : 0);
  const endTime = new Date();
  curEvents.push({ type:'punch-out', time: endTime.toISOString(), note:'' });

  await DB.addSession({
    username: currentUser.username,
    start:    sessionStart.toISOString(),
    end:      endTime.toISOString(),
    duration: totalMs,
    events:   [...curEvents],
    zone:     workZone ? { lat:workZone.lat, lng:workZone.lng, radius:workZone.radius } : null
  });

  isRunning = false; isPaused = false; autoGeopaused = false;
  pausedMs = 0; startTS = null; sessionStart = null; curEvents = [];
  await DB.del('timer', currentUser.username).catch(()=>{});

  document.getElementById('timerDisplay').textContent = '00:00:00';
  document.getElementById('timerDisplay').className   = 'timer-display';
  document.getElementById('timerStatus').textContent  = 'Session complete';
  document.getElementById('punchDetails').style.display = 'none';
  setUI('idle');

  const bms = calcBreakMs({ events: curEvents });
  const wms = totalMs - bms;
  showToast('✅ Clocked out — ' + fmtDur(wms) + ' work');
  swPost({ type: 'TIMER_STOPPED' });
  await refreshStats();
}

function tick() {
  const elapsed = pausedMs + (isRunning ? Date.now() - startTS : 0);
  document.getElementById('timerDisplay').textContent = msToHMS(elapsed);
  updatePunchDetails();
  // Heartbeat to SW every ~30s — if these stop arriving (screen locked / killed),
  // the SW watchdog fires a lock-screen notification after 90s of silence.
  if (Math.floor(elapsed/30000) !== Math.floor((elapsed-500)/30000)) {
    saveTimer();
    swPost({ type: 'HEARTBEAT' });
  }
}

// ══ Clock-out = punch-in + 8h + total break time ══
function updatePunchDetails() {
  if (!sessionStart) return;
  const elapsedMs = pausedMs + (isRunning ? Date.now() - startTS : 0);
  const breakMs   = calcLiveBreakMs();
  const workDone  = elapsedMs - breakMs;
  const remaining = Math.max(0, TARGET_MS - workDone);

  const expectedOut = new Date(sessionStart.getTime() + TARGET_MS + breakMs);
  document.getElementById('expectedOut').textContent =
    expectedOut.toLocaleTimeString([], { hour:'2-digit', minute:'2-digit' });

  document.getElementById('liveBreak').textContent = fmtDur(breakMs) || '0m 00s';
  document.getElementById('workDone').textContent  = fmtDur(workDone) || '0m 00s';
  document.getElementById('workLeft').textContent  = remaining > 0 ? fmtDur(remaining) : '✓ Done!';
  document.getElementById('workLeft').classList.toggle('good', remaining === 0);

  const workPct  = Math.min(100, (workDone / TARGET_MS) * 100);
  const breakPct = Math.min(100 - workPct, (breakMs / TARGET_MS) * 100);
  document.getElementById('progressFill').style.width  = workPct  + '%';
  document.getElementById('progressBreak').style.left  = workPct  + '%';
  document.getElementById('progressBreak').style.width = breakPct + '%';
  document.getElementById('progressPct').textContent   = Math.round(workPct) + '%';
}

function calcLiveBreakMs() {
  let ms = 0, lastOut = null;
  curEvents.forEach(ev => {
    if (ev.type === 'break-out' || ev.type === 'geo-out') lastOut = new Date(ev.time);
    else if ((ev.type === 'break-in' || ev.type === 'geo-in') && lastOut) {
      ms += new Date(ev.time) - lastOut; lastOut = null;
    }
  });
  if ((isPaused || autoGeopaused) && lastOut) ms += Date.now() - lastOut;
  return ms;
}

// ══ UI STATE ══
function setUI(state) {
  const card  = document.getElementById('timerCard');
  const disp  = document.getElementById('timerDisplay');
  const sub   = document.getElementById('timerStatus');
  const bS    = document.getElementById('btnStart');
  const bP    = document.getElementById('btnPause');
  const bE    = document.getElementById('btnStop');
  const alert = document.getElementById('geoAlert');

  card.className = 'timer-card'; disp.className = 'timer-display';
  alert.classList.remove('visible');

  if (state === 'running') {
    card.classList.add('running'); disp.classList.add('running');
    sub.textContent = sessionStart
      ? 'Since ' + sessionStart.toLocaleTimeString([], { hour:'2-digit', minute:'2-digit' }) : 'Running';
    bS.disabled = true; bP.disabled = false; bE.disabled = false;
    bS.textContent = '▶ Clock In';
  } else if (state === 'paused') {
    disp.classList.add('paused');
    sub.textContent = 'On break — tap Resume';
    bS.disabled = false; bS.textContent = '▶ Resume';
    bP.disabled = true; bE.disabled = false;
  } else if (state === 'outside') {
    card.classList.add('outside'); disp.classList.add('outside');
    sub.textContent = 'Outside zone — auto-paused';
    alert.classList.add('visible');
    bS.disabled = true; bP.disabled = true; bE.disabled = false;
  } else {
    sub.textContent = 'Ready to clock in';
    bS.disabled = false; bS.textContent = '▶ Clock In';
    bP.disabled = true; bE.disabled = true;
  }
}

// ══ TIMER PERSISTENCE ══
async function saveTimer() {
  if (!currentUser) return;
  if (!isRunning && !isPaused && !autoGeopaused) {
    await DB.del('timer', currentUser.username).catch(()=>{});
    return;
  }
  await DB.put('timer', {
    username: currentUser.username,
    startTS, pausedMs, isRunning, isPaused, autoGeopaused,
    sessionStart: sessionStart ? sessionStart.toISOString() : null,
    curEvents,
    savedAt: Date.now()
  });
}

// ══ SMART WAKE-UP RESTORE ══
// When the device powers back on / app resumes after a gap, we do NOT blindly
// insert a break for that gap. Instead we immediately request the current GPS
// position and decide based on actual location:
//   • Still inside zone  → gap was just device sleep, add as work time (no break)
//   • Outside zone       → genuine absence, record as geo break + vibrate + alert
//   • GPS unavailable    → safe fallback: record as break, warn user
async function restoreTimer() {
  const s = await DB.get('timer', currentUser.username);
  if (!s) return;

  pausedMs     = s.pausedMs     || 0;
  sessionStart = s.sessionStart ? new Date(s.sessionStart) : null;
  curEvents    = s.curEvents    || [];

  if (s.isRunning && s.startTS) {
    const gapMs    = Date.now() - s.savedAt;
    const gapStart = new Date(s.savedAt).toISOString();
    const gapEnd   = new Date().toISOString();

    if (gapMs > 8000 && workZone) {
      // Show a "checking location…" state while we resolve
      document.getElementById('timerStatus').textContent = '📡 Checking location after sleep…';
      document.getElementById('punchDetails').style.display = 'block';
      if (sessionStart) document.getElementById('punchInTime').textContent =
        sessionStart.toLocaleTimeString([], { hour:'2-digit', minute:'2-digit' });

      // Ask for GPS position with a reasonable timeout
      resolveWakeUpGap(gapMs, gapStart, gapEnd, s);

    } else {
      // Short gap (< 8s) — just resume normally, no break needed
      pausedMs += gapMs;
      startTS = Date.now(); isRunning = true;
      timerInterval = setInterval(tick, 500);
      setUI('running');
      document.getElementById('punchDetails').style.display = 'block';
      if (sessionStart) document.getElementById('punchInTime').textContent =
        sessionStart.toLocaleTimeString([], { hour:'2-digit', minute:'2-digit' });
      tick();
      showToast('🔄 Timer restored');
    }

  } else if (s.isPaused) {
    isPaused = true;
    document.getElementById('timerDisplay').textContent = msToHMS(pausedMs);
    document.getElementById('punchDetails').style.display = 'block';
    if (sessionStart) document.getElementById('punchInTime').textContent =
      sessionStart.toLocaleTimeString([], { hour:'2-digit', minute:'2-digit' });
    setUI('paused'); updatePunchDetails();

  } else if (s.autoGeopaused) {
    autoGeopaused = true;
    document.getElementById('timerDisplay').textContent = msToHMS(pausedMs);
    document.getElementById('punchDetails').style.display = 'block';
    if (sessionStart) document.getElementById('punchInTime').textContent =
      sessionStart.toLocaleTimeString([], { hour:'2-digit', minute:'2-digit' });
    setUI('outside'); updatePunchDetails();
  }
}

function resolveWakeUpGap(gapMs, gapStart, gapEnd, savedState) {
  const gapMins = Math.round(gapMs / 60000);

  navigator.geolocation.getCurrentPosition(
    pos => {
      // Got a GPS fix — check if we're still inside the zone
      const accuracy = pos.coords.accuracy;
      const dist     = haversine(pos.coords.latitude, pos.coords.longitude, workZone.lat, workZone.lng);
      const bonus    = accuracy ? Math.min(Math.ceil(accuracy), ACC_CAP) : 0;
      const effR     = workZone.radius + bonus;
      const nowInside = dist <= effR && accuracy <= ACCURACY_REJECT;

      if (nowInside) {
        // ✅ Phone never left — gap is pure device sleep, count as WORK TIME
        // Simply add the gap to elapsed work (pausedMs already has pre-gap work)
        pausedMs += gapMs;
        insideZone = true;
        updateGeoPill(true, dist, effR, accuracy);
        startTS = Date.now(); isRunning = true;
        timerInterval = setInterval(tick, 500);
        setUI('running');
        tick();
        showToast('🔄 Restored — device slept ' + gapMins + 'm, still in zone ✓');

      } else {
        // 🚨 Phone moved outside or GPS confirms absence — record as break
        curEvents.push({ type:'geo-out', time: gapStart, note: 'Device off / sleep' });
        curEvents.push({ type:'geo-in',  time: gapEnd,   note: 'App resumed' });
        pausedMs += gapMs;
        insideZone = false;
        updateGeoPill(false, dist, effR, accuracy);

        // Resume running but mark as just-returned-from-geo-break
        startTS = Date.now(); isRunning = true; autoGeopaused = false;
        timerInterval = setInterval(tick, 500);
        setUI('running');
        tick();

        // Vibrate hard to alert user that a break was recorded
        vibrate([300, 150, 300, 150, 500]);
        showToast('🚨 Was outside zone for ' + gapMins + 'm — break recorded');
        // Show the geo alert banner briefly so it's impossible to miss
        const alertEl = document.getElementById('geoAlert');
        alertEl.querySelector('.geo-alert-title').textContent = 'Break recorded for device sleep!';
        alertEl.querySelector('.geo-alert-desc').textContent =
          'Phone was outside the zone for ~' + gapMins + ' min while off. Break added to report.';
        alertEl.classList.add('visible');
        setTimeout(() => alertEl.classList.remove('visible'), 8000);
      }

      saveTimer();
      updatePunchDetails();
    },

    () => {
      // GPS unavailable on resume (no signal, denied, etc.)
      // Safe fallback: record the gap as a break so no false work time is added
      curEvents.push({ type:'geo-out', time: gapStart, note: 'Device off — GPS unavailable on resume' });
      curEvents.push({ type:'geo-in',  time: gapEnd,   note: 'App resumed' });
      pausedMs += gapMs;

      startTS = Date.now(); isRunning = true;
      timerInterval = setInterval(tick, 500);
      setUI('running');
      document.getElementById('punchDetails').style.display = 'block';
      if (sessionStart) document.getElementById('punchInTime').textContent =
        sessionStart.toLocaleTimeString([], { hour:'2-digit', minute:'2-digit' });
      tick();

      vibrate([200, 100, 200]);
      showToast('⚠ GPS unavailable — ' + gapMins + 'm gap recorded as break');
      saveTimer();
      updatePunchDetails();
    },

    // Use a slightly stale cached position if available (faster response on wake-up)
    // but not older than 30s — beyond that the phone may have moved significantly
    { enableHighAccuracy: true, timeout: 12000, maximumAge: 30000 }
  );
}

// ══ GEOFENCING ══
async function requestGeo() {
  if (!navigator.geolocation) { showToast('❌ Geolocation not supported'); return; }
  document.getElementById('geoPermStatus').textContent = 'Requesting…';
  navigator.geolocation.getCurrentPosition(
    () => {
      document.getElementById('geoPermStatus').textContent = '✅ Permission granted';
      showToast('📍 Location access granted');
      if (workZone) startWatch();
    },
    err => {
      document.getElementById('geoPermStatus').textContent =
        err.code === 1 ? '❌ Denied — enable in settings' : '❌ GPS unavailable';
    },
    { enableHighAccuracy:true, timeout:15000, maximumAge:0 }
  );
}

function requestGeoSilent() {
  if (!navigator.geolocation) return;
  navigator.permissions && navigator.permissions.query({ name:'geolocation' }).then(r => {
    if (r.state === 'granted') startWatch();
  }).catch(() => startWatch());
}

async function setWorkZone() {
  if (!navigator.geolocation) { showToast('❌ Not supported'); return; }
  const btn = document.getElementById('btnSetZone');
  btn.disabled = true; btn.textContent = '📡 Getting GPS…';
  navigator.geolocation.getCurrentPosition(
    async pos => {
      const r = Math.max(5, parseInt(document.getElementById('radiusInput').value) || 100);
      workZone = { username: currentUser.username, lat: pos.coords.latitude, lng: pos.coords.longitude, radius: r };
      await DB.put('zones', workZone);
      btn.disabled = false; btn.textContent = '📌 Update Zone';
      updateZoneDisplay(pos.coords.accuracy);
      showToast('✅ Work zone set (' + r + 'm)');
      startWatch();
    },
    err => {
      btn.disabled = false; btn.textContent = '📌 Set Zone';
      showToast(err.code === 1 ? '❌ Location denied' : '❌ GPS error — try again');
    },
    { enableHighAccuracy:true, timeout:12000, maximumAge:0 }
  );
}

function updateZoneDisplay(accuracy) {
  if (!workZone) return;
  const acc  = accuracy ? Math.round(accuracy) : null;
  const warn = acc && acc > workZone.radius * 0.5;
  const el   = document.getElementById('zoneResult');
  el.style.display = 'block';
  el.className = 'zone-result' + (warn ? ' warn' : '');
  el.innerHTML =
    `✓ <strong>${workZone.lat.toFixed(5)}, ${workZone.lng.toFixed(5)}</strong> · Radius: ${workZone.radius}m` +
    (acc ? `<br>${warn ? '⚠ GPS ±' + acc + 'm — consider increasing radius' : '✓ GPS accuracy ±' + acc + 'm'}` : '');
  document.getElementById('radiusInput').value = workZone.radius;
}

// ══ GPS WATCH ══
function startWatch() {
  if (watchId !== null) navigator.geolocation.clearWatch(watchId);
  if (!navigator.geolocation) return;

  watchId = navigator.geolocation.watchPosition(
    pos => { if (workZone) checkFence({ lat: pos.coords.latitude, lng: pos.coords.longitude }, pos.coords.accuracy); },
    ()   => { pollGeoNow(); },
    { enableHighAccuracy:true, maximumAge:2000, timeout:20000 }
  );

  if (geoFallbackInterval) clearInterval(geoFallbackInterval);
  geoFallbackInterval = setInterval(pollGeoNow, 30000);
}

function pollGeoNow() {
  if (!workZone || !navigator.geolocation) return;
  navigator.geolocation.getCurrentPosition(
    pos => checkFence({ lat: pos.coords.latitude, lng: pos.coords.longitude }, pos.coords.accuracy),
    () => {
      if (isRunning && insideZone !== false) {
        insideZone = false;
        updateGeoPill(false, Infinity, workZone.radius, null);
        doPause(true);
        saveTimer();
        showToast('🚨 GPS lost — paused');
        vibrate([200, 100, 200]);
      }
    },
    { enableHighAccuracy:true, timeout:10000, maximumAge:2000 }
  );
}

function stopWatch() {
  if (watchId !== null) { navigator.geolocation.clearWatch(watchId); watchId = null; }
  if (geoFallbackInterval) { clearInterval(geoFallbackInterval); geoFallbackInterval = null; }
}

// ══ FENCE CHECK — with accuracy filtering ══
function checkFence(pos, accuracy) {
  if (!workZone) return;

  // Reject very poor fixes (cell-tower/WiFi coarse location)
  if (accuracy && accuracy > ACCURACY_REJECT) {
    updateGeoPill(insideZone === true, null, workZone.radius, accuracy);
    return;
  }

  const dist  = haversine(pos.lat, pos.lng, workZone.lat, workZone.lng);
  const bonus = accuracy ? Math.min(Math.ceil(accuracy), ACC_CAP) : 0;
  const effR  = workZone.radius + bonus;
  const nowIn = dist <= effR;

  updateGeoPill(nowIn, dist, effR, accuracy);
  if (nowIn === insideZone) return;

  const prev = insideZone; insideZone = nowIn;

  if (!nowIn && isRunning) {
    doPause(true);
    saveTimer();
    showToast('🚨 Left zone — paused');
    vibrate([300, 150, 300]);
    swPost({ type: 'GEO_EXIT' }); // triggers lock-screen notification immediately
  }
  if (nowIn && autoGeopaused) {
    curEvents.push({ type:'geo-in', time:new Date().toISOString(), note:'Returned to zone' });
    startTS = Date.now(); isRunning = true; autoGeopaused = false;
    timerInterval = setInterval(tick, 500);
    setUI('running'); saveTimer(); updatePunchDetails();
    document.getElementById('geoAlert').classList.remove('visible');
    showToast('✅ Back in zone — resumed');
    vibrate([100]);
    swPost({ type: 'GEO_ENTER' });
  }
  if (nowIn && prev === null && !isRunning && !isPaused && !autoGeopaused)
    showToast('📍 Inside work zone — ready to clock in');
}

// ══ GEO PILL — shows distance + live GPS accuracy ══
function updateGeoPill(inside, dist, effR, accuracy) {
  const pill   = document.getElementById('geoPill');
  const accStr = accuracy ? ' ±' + Math.round(accuracy) + 'm' : '';

  let text;
  if (dist === null) {
    text = (inside ? '✓ In zone' : '✗ Out') + ' · weak GPS' + accStr;
  } else if (dist === Infinity) {
    text = '✗ GPS lost';
  } else {
    const dStr = dist < 1000 ? Math.round(dist) + 'm' : (dist / 1000).toFixed(2) + 'km';
    text = inside
      ? '✓ In zone · ' + dStr + accStr
      : '✗ ' + dStr + ' away' + accStr;
  }

  pill.className = 'geo-pill ' + (inside ? 'inside' : 'outside');
  document.getElementById('geoPillDot').style.background = inside ? 'var(--green)' : 'var(--red)';
  document.getElementById('geoPillText').textContent = text;
}

// ══ VISIBILITY CHANGE ══
// When the app comes back to foreground (screen unlock, tab switch, etc.)
// immediately poll GPS and re-evaluate zone state — never assume.
document.addEventListener('visibilitychange', async () => {
  if (document.visibilityState === 'visible') {
    if (workZone) pollGeoNow();
    if (isRunning) {
      tick();
      swPost({ type: 'HEARTBEAT' }); // app is visible again, reset watchdog
    }
    if (autoGeopaused) {
      document.getElementById('geoAlert').classList.add('visible');
      showToast('🚨 Still outside work zone');
    }
    try {
      if (wakeLock && isRunning) wakeLock = await navigator.wakeLock.request('screen');
    } catch(e) {}
  } else {
    // Screen locked / app backgrounded — send one last heartbeat so SW
    // starts the 90s countdown to show "timer still running" notification
    if (isRunning) swPost({ type: 'HEARTBEAT' });
  }
  await saveTimer();
});

// ══ STATS ══
async function refreshStats() {
  const sessions = await DB.getUserSessions(currentUser.username);
  const now      = new Date();
  const todayStr = now.toDateString();
  const monday   = new Date(now);
  monday.setDate(now.getDate() - now.getDay() + (now.getDay() === 0 ? -6 : 1));
  monday.setHours(0,0,0,0);
  const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);

  let todayW=0, todayB=0, todayN=0, weekW=0, monthW=0, totalW=0, totalB=0;
  sessions.forEach(s => {
    const d   = new Date(s.start);
    const bms = calcBreakMs(s);
    const wms = s.duration - bms;
    totalW += wms; totalB += bms;
    if (d.toDateString() === todayStr) { todayW += wms; todayB += bms; todayN++; }
    if (d >= monday)     weekW  += wms;
    if (d >= monthStart) monthW += wms;
  });

  document.getElementById('ts_work').textContent       = fmtDur(todayW) || '—';
  document.getElementById('ts_break').textContent      = fmtDur(todayB) || '—';
  document.getElementById('ts_sessions').textContent   = todayN;
  document.getElementById('stat_today').textContent    = fmtDur(todayW) || '—';
  document.getElementById('stat_week').textContent     = fmtDur(weekW)  || '—';
  document.getElementById('stat_month').textContent    = fmtDur(monthW) || '—';
  document.getElementById('stat_total').textContent    = fmtDur(totalW) || '—';
  document.getElementById('stat_sessions').textContent = sessions.length;

  const days     = new Set(sessions.map(s => new Date(s.start).toDateString())).size;
  const avgBreak = days > 0 ? Math.round(totalB / days) : 0;
  document.getElementById('stat_avg_break').textContent = fmtDur(avgBreak) || '—';
}

async function renderStats() {
  await refreshStats();
  const sessions = await DB.getUserSessions(currentUser.username);
  sessions.sort((a,b) => new Date(b.start) - new Date(a.start));
  const el = document.getElementById('recentList');
  if (!sessions.length) {
    el.innerHTML = `<div class="empty"><div class="empty-icon">📊</div>No sessions yet.</div>`; return;
  }
  el.innerHTML = sessions.slice(0,12).map(s => {
    const bms = calcBreakMs(s), wms = s.duration - bms;
    const d   = new Date(s.start);
    return `<div class="recent-item">
      <div>
        <div class="recent-date">${d.toLocaleDateString([],{weekday:'short',month:'short',day:'numeric'})}</div>
        <div class="recent-time">${new Date(s.start).toLocaleTimeString([],{hour:'2-digit',minute:'2-digit'})} – ${new Date(s.end).toLocaleTimeString([],{hour:'2-digit',minute:'2-digit'})}</div>
      </div>
      <div>
        <div class="recent-work">${fmtDur(wms)}</div>
        <div class="recent-brk">${bms > 0 ? '⏸ ' + fmtDur(bms) : 'No breaks'}</div>
      </div>
    </div>`;
  }).join('');
}

// ══ REPORT ══
function weekRange(offset) {
  const now    = new Date();
  const monday = new Date(now);
  monday.setDate(now.getDate() - now.getDay() + (now.getDay()===0 ? -6:1) + offset*7);
  monday.setHours(0,0,0,0);
  const sunday = new Date(monday);
  sunday.setDate(monday.getDate()+6); sunday.setHours(23,59,59,999);
  return { start:monday, end:sunday };
}

function reportPrev()  { weekOffset--; renderReport(); }
function reportNext()  { if (weekOffset < 0) { weekOffset++; renderReport(); } }
function reportToday() { weekOffset = 0; renderReport(); }

async function renderReport() {
  const { start, end } = weekRange(weekOffset);
  document.getElementById('reportPeriod').textContent =
    weekOffset===0 ? 'This Week' : weekOffset===-1 ? 'Last Week' :
    start.toLocaleDateString([],{month:'short',day:'numeric'}) + ' – ' +
    end.toLocaleDateString([],{month:'short',day:'numeric',year:'numeric'});

  const all     = await DB.getUserSessions(currentUser.username);
  const inRange = all.filter(s => { const d = new Date(s.start); return d >= start && d <= end; });
  const el      = document.getElementById('reportList');

  if (!inRange.length) {
    el.innerHTML = `<div class="empty"><div class="empty-icon">📋</div>No sessions this period.</div>`; return;
  }

  const byDay = {};
  inRange.forEach(s => { const k = new Date(s.start).toDateString(); if (!byDay[k]) byDay[k]=[]; byDay[k].push(s); });
  const days  = Object.entries(byDay).sort((a,b) => new Date(b[0]) - new Date(a[0]));

  el.innerHTML = days.map(([ds, daySessions], idx) => {
    const dd    = new Date(ds);
    const totMs = daySessions.reduce((a,s)=>a+s.duration, 0);
    const brkMs = daySessions.reduce((a,s)=>a+calcBreakMs(s), 0);
    const wrkMs = totMs - brkMs;
    return `<div class="day-card${idx===0?' open':''}">
      <div class="day-head" onclick="this.parentElement.classList.toggle('open')">
        <div>
          <div class="day-weekday">${dd.toLocaleDateString([],{weekday:'long'})}</div>
          <div class="day-fulldate">${dd.toLocaleDateString([],{day:'2-digit',month:'long',year:'numeric'})}</div>
        </div>
        <div class="day-right">
          <div>
            <div class="day-work">${fmtDur(wrkMs)}</div>
            <div class="day-sessions">${daySessions.length} session${daySessions.length!==1?'s':''}</div>
          </div>
          <span class="day-toggle">▼</span>
        </div>
      </div>
      <div class="day-body">
        ${daySessions.map((s,i)=>buildSessionBlock(s,i+1,daySessions.length)).join('')}
        <div class="day-totals">
          <div class="day-total-cell"><div class="day-total-lbl">Work</div><div class="day-total-val good">${fmtDur(wrkMs)}</div></div>
          <div class="day-total-cell"><div class="day-total-lbl">Break</div><div class="day-total-val warn">${fmtDur(brkMs)||'—'}</div></div>
          <div class="day-total-cell"><div class="day-total-lbl">Total Clock</div><div class="day-total-val muted">${fmtDur(totMs)}</div></div>
        </div>
      </div>
    </div>`;
  }).join('');
}

function buildSessionBlock(s, num, total) {
  const events = s.events || [{ type:'punch-in', time:s.start }, { type:'punch-out', time:s.end }];
  const bms    = calcBreakMs(s), wms = s.duration - bms;
  return `<div class="session-block">
    <div class="session-head">
      <span class="session-tag">Session ${num}${total>1?' / '+total:''}</span>
      <div style="text-align:right">
        <div style="font-size:0.55rem;color:var(--ink3);letter-spacing:0.1em;text-transform:uppercase">Work</div>
        <div class="session-work">${fmtDur(wms)}</div>
      </div>
    </div>
    <div class="timeline">${buildTimeline(events)}</div>
    ${buildBreakChips(events) ? '<div class="break-strip">'+buildBreakChips(events)+'</div>' : ''}
  </div>`;
}

function buildTimeline(events) {
  let html = '', lastBrkOut = null;
  const labels = {
    'punch-in':'Punch In','punch-out':'Punch Out',
    'break-out':'Break Out','break-in':'Break In',
    'geo-out':'Left Zone (auto)','geo-in':'Returned (auto)'
  };
  const dots = {
    'punch-in':'punch-in','punch-out':'punch-out',
    'break-out':'break-out','break-in':'break-in',
    'geo-out':'geo-out','geo-in':'geo-in'
  };
  events.forEach((ev, i) => {
    const t  = new Date(ev.time);
    const ts = t.toLocaleTimeString([], { hour:'2-digit', minute:'2-digit', second:'2-digit' });
    let dur  = '';
    if (ev.type === 'punch-out' || ev.type === 'break-out' || ev.type === 'geo-out') {
      const prev = findPrevIn(events, i);
      if (prev) dur = `<div class="tl-dur wrk">+${fmtDur(t - new Date(prev.time))} work</div>`;
      if (ev.type === 'break-out' || ev.type === 'geo-out') lastBrkOut = t;
    } else if ((ev.type === 'break-in' || ev.type === 'geo-in') && lastBrkOut) {
      dur = `<div class="tl-dur brk">Break: ${fmtDur(t - lastBrkOut)}</div>`; lastBrkOut = null;
    }
    html += `<div class="tl-event">
      <div class="tl-dot ${dots[ev.type]||''}"></div>
      <div>
        <div class="tl-time">${ts}</div>
        <div class="tl-label">${labels[ev.type]||ev.type}${ev.note?' · '+ev.note:''}</div>
        ${dur}
      </div>
    </div>`;
  });
  return html;
}

function findPrevIn(events, idx) {
  for (let i = idx-1; i >= 0; i--)
    if (['punch-in','break-in','geo-in'].includes(events[i].type)) return events[i];
  return null;
}

function buildBreakChips(events) {
  const chips = []; let lastOut = null;
  events.forEach(ev => {
    if (ev.type==='break-out'||ev.type==='geo-out') lastOut = new Date(ev.time);
    else if ((ev.type==='break-in'||ev.type==='geo-in') && lastOut) {
      chips.push(`<div class="break-chip">${ev.type==='geo-in'?'🗺 Auto':'☕ Break'}<em>${fmtDur(new Date(ev.time)-lastOut)}</em></div>`);
      lastOut = null;
    }
  });
  return chips.join('');
}

function calcBreakMs(s) {
  if (!s.events) return 0;
  let ms = 0, lastOut = null;
  s.events.forEach(ev => {
    if (ev.type==='break-out'||ev.type==='geo-out') lastOut = new Date(ev.time);
    else if ((ev.type==='break-in'||ev.type==='geo-in') && lastOut) { ms += new Date(ev.time)-lastOut; lastOut=null; }
  });
  return ms;
}

// ══ CLEAR DATA ══
async function clearAllData() {
  confirmModal('Delete All Data', 'Permanently delete all sessions and zones? This cannot be undone.', async () => {
    await DB.deleteUserSessions(currentUser.username);
    await DB.del('timer', currentUser.username).catch(()=>{});
    await DB.del('zones', currentUser.username).catch(()=>{});
    workZone = null;
    isRunning=false; isPaused=false; autoGeopaused=false;
    pausedMs=0; sessionStart=null; curEvents=[];
    clearInterval(timerInterval);
    document.getElementById('timerDisplay').textContent='00:00:00';
    document.getElementById('punchDetails').style.display='none';
    document.getElementById('zoneResult').style.display='none';
    setUI('idle'); await refreshStats();
    showToast('🗑 All data deleted');
  });
}

// ══ PDF EXPORT ══
async function exportPDF() {
  const { start, end } = weekRange(weekOffset);
  const all     = await DB.getUserSessions(currentUser.username);
  const inRange = all.filter(s => { const d = new Date(s.start); return d >= start && d <= end; });
  if (!inRange.length) { showToast('No sessions to export'); return; }

  const { jsPDF } = window.jspdf;
  const doc = new jsPDF({ orientation:'portrait', unit:'mm', format:'a4' });
  const PW=210, PH=297, ML=16, MR=16, CW=PW-ML-MR; let y=0;

  const ink=[30,26,22], ink2=[92,82,72], ink3=[158,149,144];
  const acc=[200,93,30], grn=[26,107,58], amb=[154,90,8], red=[168,28,28], blu=[26,78,216];
  const bg=[250,248,245], surf=[255,255,255], surf2=[249,247,244], brd=[230,224,214];

  const fr=(x,ry,w,h,c)=>{doc.setFillColor(c[0],c[1],c[2]);doc.rect(x,ry,w,h,'F');};
  const st=(c)=>doc.setTextColor(c[0],c[1],c[2]);

  fr(0,0,PW,PH,bg);
  fr(0,0,PW,30,surf); fr(0,0,4,30,acc); fr(0,30,PW,0.4,brd);
  doc.setFont('helvetica','bold'); doc.setFontSize(16); st(ink); doc.text('WorkTrack',8,18);
  doc.setFont('helvetica','normal'); doc.setFontSize(7.5); st(ink3); doc.text('Daily Work Report',8,24.5);
  doc.setFontSize(7); st(ink3);
  doc.text('Generated '+new Date().toLocaleString([],{day:'2-digit',month:'short',year:'numeric',hour:'2-digit',minute:'2-digit'}),PW-MR,10,{align:'right'});
  const per=weekOffset===0?'This Week':weekOffset===-1?'Last Week':
    start.toLocaleDateString([],{month:'short',day:'numeric'})+' – '+
    end.toLocaleDateString([],{month:'short',day:'numeric',year:'numeric'});
  doc.setFontSize(8.5); doc.setFont('helvetica','bold'); st(ink2); doc.text(per,PW-MR,19,{align:'right'});
  doc.setFontSize(7); doc.setFont('helvetica','normal'); st(ink3);
  doc.text('User: '+currentUser.name+' (@'+currentUser.username+')',PW-MR,26,{align:'right'});
  y=36;

  const wW=inRange.reduce((a,s)=>a+s.duration-calcBreakMs(s),0);
  const wB=inRange.reduce((a,s)=>a+calcBreakMs(s),0);
  const wD=new Set(inRange.map(s=>new Date(s.start).toDateString())).size;
  doc.setFillColor(surf2[0],surf2[1],surf2[2]); doc.rect(ML,y,CW,18,'F');
  doc.setDrawColor(brd[0],brd[1],brd[2]); doc.setLineWidth(0.3); doc.rect(ML,y,CW,18,'S');
  [{lbl:'Total Work',val:fmtDur(wW)||'—',col:grn},
   {lbl:'Total Breaks',val:fmtDur(wB)||'None',col:amb},
   {lbl:'Days Worked',val:wD+' day'+(wD!==1?'s':''),col:blu}
  ].forEach((item,i)=>{
    const cx=ML+CW/3*i+CW/6;
    doc.setFont('helvetica','bold'); doc.setFontSize(10.5);
    doc.setTextColor(item.col[0],item.col[1],item.col[2]); doc.text(item.val,cx,y+10.5,{align:'center'});
    doc.setFont('helvetica','normal'); doc.setFontSize(6); st(ink3);
    doc.text(item.lbl.toUpperCase(),cx,y+16,{align:'center'});
    if(i>0){doc.setDrawColor(brd[0],brd[1],brd[2]);doc.setLineWidth(0.3);doc.line(ML+CW/3*i,y+2,ML+CW/3*i,y+16);}
  });
  y+=24;

  const byDay={};
  inRange.forEach(s=>{const k=new Date(s.start).toDateString();if(!byDay[k])byDay[k]=[];byDay[k].push(s);});
  const evConf={
    'punch-in':{col:grn,lbl:'Punch In'},'punch-out':{col:acc,lbl:'Punch Out'},
    'break-out':{col:amb,lbl:'Break Out'},'break-in':{col:blu,lbl:'Break In'},
    'geo-out':{col:red,lbl:'Left Zone'},'geo-in':{col:grn,lbl:'Returned to Zone'}
  };
  function chkPg(n){if(y+n>PH-14){doc.addPage();fr(0,0,PW,PH,bg);y=16;}}

  Object.entries(byDay).forEach(([ds,daySessions])=>{
    const dd=new Date(ds);
    const totMs=daySessions.reduce((a,s)=>a+s.duration,0);
    const brkMs=daySessions.reduce((a,s)=>a+calcBreakMs(s),0);
    const wrkMs=totMs-brkMs;
    chkPg(36);
    doc.setFillColor(surf2[0],surf2[1],surf2[2]); doc.rect(ML,y,CW,12,'F');
    doc.setFillColor(acc[0],acc[1],acc[2]); doc.rect(ML,y,4,12,'F');
    doc.setFont('helvetica','bold'); doc.setFontSize(9.5); st(ink);
    doc.text(dd.toLocaleDateString([],{weekday:'long',day:'2-digit',month:'long',year:'numeric'}),ML+7,y+8.5);
    doc.setTextColor(grn[0],grn[1],grn[2]); doc.text(fmtDur(wrkMs),PW-MR,y+8.5,{align:'right'});
    y+=14;

    daySessions.forEach((s,si)=>{
      const evs=s.events||[{type:'punch-in',time:s.start},{type:'punch-out',time:s.end}];
      const bms=calcBreakMs(s),wms=s.duration-bms;
      chkPg(12+evs.length*8+10);
      doc.setFillColor(surf[0],surf[1],surf[2]); doc.rect(ML+2,y,CW-4,8,'F');
      doc.setDrawColor(brd[0],brd[1],brd[2]); doc.setLineWidth(0.25); doc.rect(ML+2,y,CW-4,8,'S');
      doc.setFont('helvetica','normal'); doc.setFontSize(6.5); st(ink3);
      doc.text('SESSION '+(si+1)+(daySessions.length>1?' / '+daySessions.length:''),ML+6,y+5.5);
      doc.setFont('helvetica','bold'); doc.setFontSize(7.5);
      doc.setTextColor(grn[0],grn[1],grn[2]); doc.text(fmtDur(wms)+' work',PW-MR-2,y+5.5,{align:'right'});
      y+=10;
      let lastBrk=null;
      evs.forEach((ev,ei)=>{
        const t=new Date(ev.time),ts=t.toLocaleTimeString([],{hour:'2-digit',minute:'2-digit',second:'2-digit'});
        const conf=evConf[ev.type]||{col:ink3,lbl:ev.type};
        chkPg(8);
        doc.setFillColor(conf.col[0],conf.col[1],conf.col[2]); doc.circle(ML+8,y+2.5,1.5,'F');
        doc.setFont('helvetica','bold'); doc.setFontSize(7.5); st(ink); doc.text(ts,ML+13,y+4);
        doc.setFont('helvetica','normal'); doc.setFontSize(6.5); st(ink2);
        doc.text(conf.lbl+(ev.note?' · '+ev.note:''),ML+34,y+4);
        if(ev.type==='break-out'||ev.type==='geo-out') lastBrk=t;
        else if((ev.type==='break-in'||ev.type==='geo-in')&&lastBrk){
          doc.setFont('helvetica','italic');doc.setFontSize(6.5);
          doc.setTextColor(amb[0],amb[1],amb[2]);
          doc.text('Break: '+fmtDur(t-lastBrk),PW-MR-2,y+4,{align:'right'});lastBrk=null;
        } else if(ev.type==='punch-out'){
          const pi=findPrevIn(evs,ei);
          if(pi){doc.setFont('helvetica','italic');doc.setFontSize(6.5);
            doc.setTextColor(grn[0],grn[1],grn[2]);
            doc.text('+'+fmtDur(t-new Date(pi.time)),PW-MR-2,y+4,{align:'right'});}
        }
        y+=8;
      });
      doc.setFillColor(surf2[0],surf2[1],surf2[2]); doc.rect(ML+2,y,CW-4,7,'F');
      [{lbl:'Work',val:fmtDur(wms),col:grn},{lbl:'Break',val:fmtDur(bms)||'—',col:amb},{lbl:'Total',val:fmtDur(s.duration),col:ink2}].forEach((c,ci)=>{
        const cx2=ML+2+(CW-4)/3*ci+(CW-4)/6;
        doc.setFont('helvetica','bold'); doc.setFontSize(7);
        doc.setTextColor(c.col[0],c.col[1],c.col[2]); doc.text(c.val,cx2,y+5,{align:'center'});
      });
      y+=10;
    });

    chkPg(12);
    doc.setFillColor(surf2[0],surf2[1],surf2[2]); doc.rect(ML,y,CW,9,'F');
    doc.setFont('helvetica','bold'); doc.setFontSize(6.5); st(ink3); doc.text('DAY TOTAL',ML+4,y+6.5);
    doc.setTextColor(grn[0],grn[1],grn[2]); doc.text(fmtDur(wrkMs)+' work',ML+28,y+6.5);
    doc.setFont('helvetica','normal'); doc.setFontSize(6.5);
    doc.setTextColor(amb[0],amb[1],amb[2]); doc.text('  ·  '+(fmtDur(brkMs)||'no breaks'),ML+60,y+6.5);
    y+=14;
  });

  const np=doc.getNumberOfPages();
  for(let p=1;p<=np;p++){
    doc.setPage(p); fr(0,PH-10,PW,10,surf2);
    doc.setDrawColor(brd[0],brd[1],brd[2]); doc.setLineWidth(0.3); doc.line(0,PH-10,PW,PH-10);
    doc.setFont('helvetica','normal'); doc.setFontSize(6.5); st(ink3);
    doc.text('WorkTrack  ·  '+currentUser.name,ML,PH-4);
    doc.text('Page '+p+' of '+np,PW-MR,PH-4,{align:'right'});
  }
  doc.save('worktrack-'+start.toISOString().slice(0,10)+'.pdf');
  showToast('📄 PDF downloaded!');
}

// ══ CSV / TXT ══
async function exportCSV() {
  const { start, end } = weekRange(weekOffset);
  const all     = await DB.getUserSessions(currentUser.username);
  const inRange = all.filter(s=>{ const d=new Date(s.start); return d>=start&&d<=end; });
  if (!inRange.length) { showToast('No sessions to export'); return; }
  let csv='Date,Session,Event,Time,Note,Break,Work\n';
  inRange.forEach((s,si)=>{
    const evs=s.events||[];
    const ds=new Date(s.start).toLocaleDateString();
    let lastOut=null;
    evs.forEach(ev=>{
      const t=new Date(ev.time),ts=t.toLocaleTimeString([],{hour:'2-digit',minute:'2-digit',second:'2-digit'});
      let brkDur='',wrkDur='';
      if(ev.type==='break-in'||ev.type==='geo-in'){if(lastOut){brkDur=fmtDur(t-lastOut);lastOut=null;}}
      if(ev.type==='break-out'||ev.type==='geo-out') lastOut=t;
      if(ev.type==='punch-out'){const pi=findPrevIn(evs,evs.indexOf(ev));if(pi)wrkDur=fmtDur(t-new Date(pi.time));}
      csv+=`"${ds}","${si+1}","${ev.type}","${ts}","${ev.note||''}","${brkDur}","${wrkDur}"\n`;
    });
    const bms=calcBreakMs(s);
    csv+=`"${ds}","${si+1}","session-total","","","${fmtDur(bms)||'none'}","${fmtDur(s.duration-bms)}"\n`;
  });
  dlFile('worktrack-report.csv',csv,'text/csv');
}

async function exportText() {
  const { start, end } = weekRange(weekOffset);
  const all     = await DB.getUserSessions(currentUser.username);
  const inRange = all.filter(s=>{ const d=new Date(s.start); return d>=start&&d<=end; });
  if (!inRange.length) { showToast('No sessions to export'); return; }
  let txt='WORKTRACK DAILY REPORT\n'+'═'.repeat(50)+'\n';
  txt+=`User: ${currentUser.name} (@${currentUser.username})\n`;
  txt+=`Period: ${start.toLocaleDateString()} – ${end.toLocaleDateString()}\n`;
  txt+=`Generated: ${new Date().toLocaleString()}\n\n`;
  const byDay={};
  inRange.forEach(s=>{const k=new Date(s.start).toDateString();if(!byDay[k])byDay[k]=[];byDay[k].push(s);});
  Object.entries(byDay).forEach(([ds,daySessions])=>{
    const dd=new Date(ds);
    const totMs=daySessions.reduce((a,s)=>a+s.duration,0);
    const brkMs=daySessions.reduce((a,s)=>a+calcBreakMs(s),0);
    txt+=`${dd.toLocaleDateString([],{weekday:'long',day:'2-digit',month:'long',year:'numeric'})}\n${'─'.repeat(50)}\n`;
    daySessions.forEach((s,si)=>{
      const evs=s.events||[];
      txt+=`  Session ${si+1}:\n`;
      let lastOut=null;
      evs.forEach(ev=>{
        const t=new Date(ev.time),ts=t.toLocaleTimeString([],{hour:'2-digit',minute:'2-digit',second:'2-digit'});
        const lbls={'punch-in':'▶ PUNCH IN','punch-out':'■ PUNCH OUT','break-out':'⏸ BREAK OUT',
          'break-in':'▶ BREAK IN','geo-out':'↗ LEFT ZONE','geo-in':'↩ BACK IN  '};
        let dur='';
        if((ev.type==='break-in'||ev.type==='geo-in')&&lastOut){dur=' (break: '+fmtDur(t-lastOut)+')';lastOut=null;}
        if(ev.type==='break-out'||ev.type==='geo-out') lastOut=t;
        txt+=`    ${lbls[ev.type]||ev.type}  ${ts}${dur}\n`;
      });
      const bms=calcBreakMs(s);
      txt+=`    Work: ${fmtDur(s.duration-bms)}  |  Break: ${fmtDur(bms)||'—'}\n\n`;
    });
    txt+=`  Day Total: ${fmtDur(totMs-brkMs)} work  |  ${fmtDur(brkMs)||'no breaks'}\n\n`;
  });
  dlFile('worktrack-report.txt',txt,'text/plain');
}

function dlFile(name,content,type){
  const a=document.createElement('a');
  a.href=URL.createObjectURL(new Blob([content],{type}));
  a.download=name; a.click();
  showToast('⬇ Exported '+name);
}

// ══ UTILS ══
function haversine(la1,ln1,la2,ln2){
  const R=6371000,dl=(la2-la1)*Math.PI/180,dn=(ln2-ln1)*Math.PI/180;
  const a=Math.sin(dl/2)**2+Math.cos(la1*Math.PI/180)*Math.cos(la2*Math.PI/180)*Math.sin(dn/2)**2;
  return R*2*Math.atan2(Math.sqrt(a),Math.sqrt(1-a));
}
function msToHMS(ms){
  const s=Math.floor(ms/1000);
  return[Math.floor(s/3600),Math.floor(s%3600/60),s%60].map(v=>String(v).padStart(2,'0')).join(':');
}
function fmtDur(ms){
  if(!ms||ms<0)return'';
  const s=Math.floor(ms/1000),h=Math.floor(s/3600),m=Math.floor(s%3600/60);
  return h>0?`${h}h ${String(m).padStart(2,'0')}m`:`${m}m ${String(s%60).padStart(2,'0')}s`;
}
function showToast(msg){
  const t=document.getElementById('toast');
  t.textContent=msg; t.classList.add('show');
  clearTimeout(toastTmr);
  toastTmr=setTimeout(()=>t.classList.remove('show'),2800);
}
function vibrate(p){try{navigator.vibrate?.(p);}catch(e){}}
async function doWakeLock(){
  try{if('wakeLock' in navigator) wakeLock=await navigator.wakeLock.request('screen');}catch(e){}
}
function confirmModal(title,body,onOk){
  document.getElementById('modalTitle').textContent=title;
  document.getElementById('modalBody').textContent=body;
  document.getElementById('modalOk').onclick=()=>{closeModal();onOk();};
  document.getElementById('modalBg').classList.add('visible');
}
function closeModal(){ document.getElementById('modalBg').classList.remove('visible'); }

window.addEventListener('pagehide', saveTimer);
window.addEventListener('beforeunload', saveTimer);
document.addEventListener('keydown',e=>{
  if(e.key==='Enter'){
    if(document.getElementById('loginForm').style.display!=='none') doLogin();
    else doRegister();
  }
});

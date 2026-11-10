(() => {
  'use strict';

  const $ = (id) => document.getElementById(id);
  const SPACING = 16; // px between stations on the dial
  const LEVELS = ['Local', 'Regional', 'National', 'World'];
  const SEGMENTS = {
    rooms: (s) => ['TOWN', 'REGION', 'NATION', 'WORLD'][s.lv],
    voices: (s) => (s.lr === 'L' ? 'LEFT' : 'RIGHT'),
    wire: () => 'WIRE',
  };
  const TYPES = { room: 'Chamber', show: 'Political show', news: 'News channel', tank: 'Think tank', party: 'Party' };
  const BASE_FREQ = { rooms: 88, voices: 530, wire: 26 };

  let regionNames = null;
  try { regionNames = new Intl.DisplayNames(['en'], { type: 'region' }); } catch (e) { /* older browsers */ }
  const country = (iso) => {
    if (iso === 'INT') return 'International';
    try { return (regionNames && regionNames.of(iso)) || iso; } catch (e) { return iso; }
  };

  const state = {
    data: null,
    band: 'rooms',
    pos: 0,
    vel: 0,
    target: null, // index we are sweeping to (seek / scan / keys)
    dragging: false,
    nearest: -1,
    tuned: -1, // index the receiver last tried to tune
    locked: false,
    token: 0,
    autoAdvance: 0, // direction to keep seeking if a station fails (initial tune, scan, seek)
    saved: {},
    visited: new Set(),
    started: 0,
    staticOn: true,
  };

  const els = {
    screen: $('screen'), staticCv: $('static'), dial: $('dial'), knob: $('knob'),
    name: $('stName'), meta: $('stMeta'), freq: $('freq'), lamp: $('lamp'), link: $('stLink'),
    ns: $('nosignal'), nsTitle: $('nsTitle'), nsText: $('nsText'), nsLink: $('nsLink'),
  };

  const stations = () => state.data[state.band];

  /* ---------- static: picture ---------- */

  const sctx = els.staticCv.getContext('2d');
  const simg = sctx.createImageData(els.staticCv.width, els.staticCv.height);
  const sbuf = new Uint32Array(simg.data.buffer);
  function drawStatic() {
    for (let i = 0; i < sbuf.length; i++) {
      const v = (Math.random() * 190) | 0;
      sbuf[i] = 0xff000000 | (v << 16) | (v << 8) | v;
    }
    sctx.putImageData(simg, 0, 0);
  }

  /* ---------- static: sound ---------- */

  let actx = null, noiseGain = null, noiseFilter = null;
  function startAudio() {
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return;
    actx = new AC();
    const len = actx.sampleRate * 2;
    const buf = actx.createBuffer(1, len, actx.sampleRate);
    const ch = buf.getChannelData(0);
    for (let i = 0; i < len; i++) ch[i] = Math.random() * 2 - 1;
    const src = actx.createBufferSource();
    src.buffer = buf;
    src.loop = true;
    noiseFilter = actx.createBiquadFilter();
    noiseFilter.type = 'bandpass';
    noiseFilter.frequency.value = 1800;
    noiseFilter.Q.value = 0.6;
    noiseGain = actx.createGain();
    noiseGain.gain.value = 0;
    src.connect(noiseFilter).connect(noiseGain).connect(actx.destination);
    src.start();
  }
  function setNoise(level) {
    if (!actx) return;
    const v = state.staticOn ? level : 0;
    noiseGain.gain.setTargetAtTime(v, actx.currentTime, 0.12);
  }

  /* ---------- YouTube ---------- */

  let player = null, playerReady = false, pendingTune = false;
  let tuneTimer = 0, failTimer = 0, tries = 0, seeked = false, autoTries = 0, stage = 0, sawError = false;
  let staleVideo = '', loadedFor = '';

  function loadYouTube() {
    window.onYouTubeIframeAPIReady = () => {
      player = new YT.Player('player', {
        width: '100%',
        height: '100%',
        playerVars: { controls: 0, rel: 0, playsinline: 1, iv_load_policy: 3, disablekb: 1, fs: 0 },
        events: {
          onReady: () => { playerReady = true; if (pendingTune) tune(state.tuned, true); },
          onStateChange: onPlayerState,
          onError: onPlayerError,
        },
      });
    };
    const tag = document.createElement('script');
    tag.src = 'https://www.youtube.com/iframe_api';
    document.head.appendChild(tag);
  }

  const currentVideo = () => {
    const d = player && player.getVideoData ? player.getVideoData() : null;
    return (d && d.video_id) || '';
  };

  function onPlayerState(e) {
    if (e.data !== 1) return; // only care about PLAYING
    const s = stations()[state.tuned];
    if (!s || !s.yt) { player.pauseVideo(); return; }
    // a late "playing" event from the station we just left must not lock the new one
    if (staleVideo && currentVideo() === staleVideo) return;
    if (!seeked) {
      seeked = true;
      const dur = player.getDuration ? player.getDuration() : 0;
      // drop into the middle of the broadcast, like walking into a room mid-meeting
      if (dur > 180) {
        const token = state.token;
        player.seekTo(dur * (0.15 + Math.random() * 0.6), true);
        setTimeout(() => {
          if (token === state.token && !state.locked && state.tuned >= 0 && player.getPlayerState() === 1 && currentVideo() !== staleVideo) lock();
        }, 2500);
        return;
      }
    }
    lock();
  }

  // Chambers stream their sittings, so try the channel's live-stream list first (UULV),
  // then its long-form uploads (UULF, no Shorts), then everything (UU).
  function playlistsFor(s) {
    const tail = s.yt.slice(2);
    return (s.t === 'room' ? ['UULV', 'UULF', 'UU'] : ['UULF', 'UU']).map((p) => p + tail);
  }

  function loadStage() {
    const s = stations()[state.tuned];
    const lists = playlistsFor(s);
    if (stage >= lists.length) { fail(sawError ? 'blocked' : 'weak'); return; }
    tries = 0;
    seeked = false;
    // stop first: loading a list over a paused or playing video makes the player start the list
    // requested before this one
    player.stopVideo();
    player.loadPlaylist({ listType: 'playlist', list: lists[stage], index: 0 });
    clearTimeout(failTimer);
    failTimer = setTimeout(() => { if (!state.locked) { stage++; loadStage(); } }, 7000);
  }

  function onPlayerError() {
    if (state.tuned < 0) return;
    sawError = true;
    tries++;
    if (tries < 2 && player.nextVideo) { seeked = false; player.nextVideo(); return; }
    stage++;
    loadStage();
  }

  function lock() {
    clearTimeout(failTimer);
    state.locked = true;
    state.autoAdvance = 0;
    autoTries = 0;
    els.screen.classList.add('is-locked');
    els.lamp.className = 'lamp is-on';
    setNoise(0);
    const s = stations()[state.tuned];
    if (s) loadedFor = s.id;
    if (s && !state.visited.has(s.id)) {
      state.visited.add(s.id);
      $('visited').textContent = state.visited.size;
    }
  }

  function unlock() {
    state.locked = false;
    clearTimeout(failTimer);
    els.screen.classList.remove('is-locked');
    els.ns.hidden = true;
    els.lamp.className = 'lamp';
    if (playerReady && player.stopVideo) player.stopVideo();
    setNoise(0.11);
  }

  function fail(kind) {
    clearTimeout(failTimer);
    const s = stations()[state.tuned];
    if (!s) return;
    if (state.autoAdvance && autoTries < 8) { autoTries++; seek(state.autoAdvance, true); return; }
    state.autoAdvance = 0;
    if (playerReady && player.stopVideo) player.stopVideo();
    state.locked = false;
    els.screen.classList.remove('is-locked');
    els.lamp.className = 'lamp is-dark';
    setNoise(0.045);
    if (kind === 'dark') {
      els.nsTitle.textContent = 'Dark station';
      els.nsText.textContent = 'This room exists, but we found no broadcast channel we could verify.';
      els.nsLink.textContent = 'Visit this room';
      els.nsLink.href = s.u;
    } else {
      els.nsTitle.textContent = kind === 'weak' ? 'Weak signal' : 'Signal blocked';
      els.nsText.textContent = kind === 'weak'
        ? 'This station is not answering right now.'
        : 'This channel does not let its broadcasts play outside YouTube.';
      els.nsLink.textContent = 'Watch on YouTube';
      els.nsLink.href = 'https://www.youtube.com/channel/' + s.yt;
    }
    els.nsLink.hidden = !els.nsLink.getAttribute('href');
    els.ns.hidden = false;
  }

  function tune(i, force) {
    if (i === state.tuned && !force) return;
    state.tuned = i;
    state.token++;
    tries = 0;
    seeked = false;
    const s = stations()[i];
    state.saved[state.band] = i;
    history.replaceState(null, '', '#' + state.band + '/' + s.id);
    if (!s.yt) { fail('dark'); return; }
    if (!playerReady) { pendingTune = true; return; }
    pendingTune = false;
    els.ns.hidden = true;
    stage = 0;
    sawError = false;
    staleVideo = loadedFor === s.id ? '' : currentVideo();
    loadStage();
  }

  /* ---------- plate ---------- */

  function showStation(i) {
    const s = stations()[i];
    if (!s) return;
    els.name.textContent = s.n;
    const bits = [country(s.c)];
    bits.push(s.t === 'room' ? LEVELS[s.lv] : TYPES[s.t]);
    if (s.lr) bits.push(s.lr === 'L' ? 'Left' : 'Right');
    els.meta.textContent = bits.join(' · ');
    els.link.href = s.u || '#';
    els.link.hidden = !s.u;
    els.dial.setAttribute('aria-valuenow', i);
    els.dial.setAttribute('aria-valuetext', s.n);
  }

  /* ---------- dial ---------- */

  const dctx = els.dial.getContext('2d');
  let dw = 0, dh = 0;
  function sizeDial() {
    const r = els.dial.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    dw = r.width; dh = r.height;
    els.dial.width = Math.round(dw * dpr);
    els.dial.height = Math.round(dh * dpr);
    dctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  function drawDial() {
    const list = stations();
    const cx = dw / 2;
    dctx.clearRect(0, 0, dw, dh);
    const first = Math.max(0, Math.floor(state.pos - cx / SPACING) - 1);
    const last = Math.min(list.length - 1, Math.ceil(state.pos + cx / SPACING) + 1);
    const seg = SEGMENTS[state.band];
    const base = dh - 14;
    dctx.textBaseline = 'alphabetic';
    for (let i = first; i <= last; i++) {
      const s = list[i];
      const x = cx + (i - state.pos) * SPACING;
      const near = 1 - Math.min(1, Math.abs(i - state.pos) / 3);
      let color = 'rgba(233,223,201,0.22)';
      let h = 12;
      if (s.yt) {
        h = 26 + near * 10;
        color = s.lr === 'L' ? '#5b9bdc' : s.lr === 'R' ? '#e0704c' : '#ffb347';
      }
      dctx.globalAlpha = s.yt ? 0.55 + near * 0.45 : 1;
      dctx.fillStyle = color;
      dctx.fillRect(Math.round(x) - 1, base - h, 2, h);
      dctx.globalAlpha = 1;
      if (i % 10 === 0) {
        dctx.fillStyle = 'rgba(233,223,201,0.55)';
        dctx.font = '10px "IBM Plex Mono", monospace';
        dctx.textAlign = 'center';
        dctx.fillText((BASE_FREQ[state.band] + i * 0.1).toFixed(0), x, dh - 2);
      }
      if (i === 0 || seg(list[i - 1]) !== seg(s)) {
        dctx.fillStyle = '#e9dfc9';
        dctx.font = '500 13px Oswald, "Arial Narrow", sans-serif';
        dctx.textAlign = 'left';
        dctx.fillText(seg(s), x + 4, 18);
        dctx.fillRect(Math.round(x) - 1, 6, 1, base - 6);
      }
    }
    // sticky label for the segment under the needle
    const cur = list[Math.max(0, Math.min(list.length - 1, Math.round(state.pos)))];
    dctx.fillStyle = 'rgba(233,223,201,0.4)';
    dctx.font = '500 11px Oswald, "Arial Narrow", sans-serif';
    dctx.textAlign = 'right';
    dctx.fillText(seg(cur), dw - 10, 18);
  }

  const clampPos = (p) => Math.max(0, Math.min(stations().length - 1, p));

  function frame() {
    const list = stations();
    if (!state.dragging) {
      if (state.target !== null) {
        const d = state.target - state.pos;
        const step = Math.max(-30, Math.min(30, d * 0.14));
        state.pos += step;
        if (Math.abs(d) < 0.01) { state.pos = state.target; state.target = null; }
      } else if (Math.abs(state.vel) > 0.01) {
        state.pos = clampPos(state.pos + state.vel);
        state.vel *= 0.92;
      } else {
        state.vel = 0;
        const snap = Math.round(state.pos);
        state.pos += (snap - state.pos) * 0.22;
        if (Math.abs(snap - state.pos) < 0.003) state.pos = snap;
      }
    }
    const nearest = Math.max(0, Math.min(list.length - 1, Math.round(state.pos)));
    if (nearest !== state.nearest) {
      state.nearest = nearest;
      showStation(nearest);
      if (state.tuned !== -1 && nearest !== state.tuned) {
        // moved off the station: back to static until the dial settles again
        unlock();
        state.tuned = -1;
      }
    }
    const settled = !state.dragging && state.target === null && state.vel === 0 && state.pos === nearest;
    if (settled && nearest !== state.tuned && !tuneTimer) {
      tuneTimer = setTimeout(() => { tuneTimer = 0; if (state.nearest === nearest) tune(nearest); }, 260);
    }
    if (!settled && tuneTimer) { clearTimeout(tuneTimer); tuneTimer = 0; }

    els.freq.textContent = (BASE_FREQ[state.band] + state.pos * 0.1).toFixed(1);
    els.knob.style.transform = 'rotate(' + (state.pos * 22) + 'deg)';
    if (noiseFilter) noiseFilter.frequency.value = 1200 + Math.abs(Math.sin(state.pos * 1.7)) * 2200;
    drawDial();
    if (!state.locked) drawStatic();
    requestAnimationFrame(frame);
  }

  function nudge(by) {
    state.autoAdvance = 0;
    state.vel = 0;
    const from = state.target !== null ? state.target : Math.round(state.pos);
    state.target = clampPos(from + by);
  }

  function seek(dir, auto) {
    const list = stations();
    const n = list.length;
    let i = state.target !== null && !auto ? state.target : Math.round(state.pos);
    for (let k = 0; k < n; k++) {
      i = (i + dir + n) % n;
      if (list[i].yt) break;
    }
    state.autoAdvance = dir;
    state.vel = 0;
    state.target = i;
  }

  function scan() {
    const list = stations();
    const ok = [];
    list.forEach((s, i) => { if (s.yt && i !== state.tuned) ok.push(i); });
    if (!ok.length) return;
    state.autoAdvance = 1;
    state.vel = 0;
    state.target = ok[(Math.random() * ok.length) | 0];
  }

  function setBand(band, index) {
    if (!state.data[band]) return;
    state.band = band;
    document.querySelectorAll('.band').forEach((b) => {
      const on = b.dataset.band === band;
      b.classList.toggle('is-on', on);
      b.setAttribute('aria-selected', on);
    });
    unlock();
    state.tuned = -1;
    state.nearest = -1;
    state.target = null;
    state.vel = 0;
    els.dial.setAttribute('aria-valuemax', state.data[band].length - 1);
    if (index === undefined) index = state.saved[band];
    if (index === undefined) {
      const ok = [];
      state.data[band].forEach((s, i) => { if (s.yt) ok.push(i); });
      index = ok[(Math.random() * ok.length) | 0] || 0;
      state.autoAdvance = 1;
    }
    state.pos = index;
  }

  /* ---------- input ---------- */

  function bindDrag(el, pxPerStation) {
    let lastX = 0, lastT = 0;
    el.addEventListener('pointerdown', (e) => {
      state.dragging = true;
      state.target = null;
      state.autoAdvance = 0;
      state.vel = 0;
      lastX = e.clientX; lastT = performance.now();
      el.setPointerCapture(e.pointerId);
    });
    el.addEventListener('pointermove', (e) => {
      if (!state.dragging) return;
      const now = performance.now();
      const d = (lastX - e.clientX) / pxPerStation;
      state.pos = clampPos(state.pos + d);
      const dt = Math.max(1, now - lastT);
      state.vel = state.vel * 0.6 + (d / dt) * 16 * 0.4;
      lastX = e.clientX; lastT = now;
    });
    const end = () => {
      if (!state.dragging) return;
      state.dragging = false;
      if (performance.now() - lastT > 80) state.vel = 0;
    };
    el.addEventListener('pointerup', end);
    el.addEventListener('pointercancel', end);
  }

  function bindInput() {
    bindDrag(els.dial, SPACING);
    bindDrag(els.knob, -SPACING * 2.5); // the knob is a fine-tune: drag right to move up the dial

    els.dial.addEventListener('wheel', (e) => {
      e.preventDefault();
      const d = Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX : e.deltaY;
      state.target = null;
      state.autoAdvance = 0;
      state.vel = Math.max(-6, Math.min(6, state.vel + d / 220));
    }, { passive: false });

    document.addEventListener('keydown', (e) => {
      if ($('set').hidden || !$('about').hidden) { if (e.key === 'Escape') $('about').hidden = true; return; }
      if (e.target.closest && e.target.closest('button, a')) { if (e.key === ' ' || e.key === 'Enter') return; }
      if (e.key === 'ArrowRight') { e.preventDefault(); e.shiftKey ? seek(1) : nudge(1); }
      else if (e.key === 'ArrowLeft') { e.preventDefault(); e.shiftKey ? seek(-1) : nudge(-1); }
    });

    $('seekPrev').addEventListener('click', () => seek(-1));
    $('seekNext').addEventListener('click', () => seek(1));
    $('scan').addEventListener('click', scan);
    $('mute').addEventListener('click', (e) => {
      state.staticOn = !state.staticOn;
      e.currentTarget.textContent = state.staticOn ? 'Static on' : 'Static off';
      e.currentTarget.setAttribute('aria-pressed', String(!state.staticOn));
      setNoise(state.locked ? 0 : 0.11);
    });
    document.querySelectorAll('.band').forEach((b) => b.addEventListener('click', () => {
      if (b.dataset.band !== state.band) setBand(b.dataset.band);
    }));
    $('aboutBtn').addEventListener('click', () => { $('about').hidden = false; });
    $('aboutClose').addEventListener('click', () => { $('about').hidden = true; });
    $('about').addEventListener('click', (e) => { if (e.target.id === 'about') $('about').hidden = true; });
    window.addEventListener('resize', sizeDial);
  }

  /* ---------- start ---------- */

  function fillStats() {
    const all = [].concat(state.data.rooms, state.data.voices, state.data.wire);
    const countries = new Set(all.map((s) => s.c).filter((c) => c !== 'INT'));
    const playable = all.filter((s) => s.yt).length;
    $('introRooms').textContent = all.length.toLocaleString('en');
    $('introCountries').textContent = countries.size;
    const lv = [0, 0, 0, 0];
    state.data.rooms.forEach((s) => { lv[s.lv]++; });
    $('aboutStats').innerHTML = [
      '<b>' + all.length.toLocaleString('en') + '</b> stations in <b>' + countries.size + '</b> countries',
      '<b>' + playable + '</b> with a broadcast, <b>' + (all.length - playable) + '</b> dark',
      '<b>' + lv[0] + '</b> local, <b>' + lv[1] + '</b> regional, <b>' + lv[2] + '</b> national and <b>' + lv[3] + '</b> world chambers',
    ].map((t) => '<li>' + t + '</li>').join('');
  }

  function tick() {
    const s = Math.floor((Date.now() - state.started) / 1000);
    const mm = String(Math.floor(s / 60)).padStart(2, '0');
    $('clock').textContent = mm + ':' + String(s % 60).padStart(2, '0');
  }

  function powerOn() {
    if (!state.data) return;
    $('intro').classList.add('is-off');
    $('set').hidden = false;
    startAudio();
    loadYouTube();
    sizeDial();
    state.started = Date.now();
    setInterval(tick, 1000);

    let band = 'rooms', index;
    const m = location.hash.match(/^#(rooms|voices|wire)\/(REC\d+)$/);
    if (m) {
      const i = state.data[m[1]].findIndex((s) => s.id === m[2]);
      if (i >= 0) { band = m[1]; index = i; }
    }
    setBand(band, index);
    requestAnimationFrame(frame);
  }

  fetch('data/stations.json')
    .then((r) => r.json())
    .then((d) => { state.data = d; fillStats(); })
    .catch(() => { document.querySelector('.intro-note').textContent = 'The station list failed to load. Reload the page.'; });

  bindInput();
  $('power').addEventListener('click', powerOn);
})();

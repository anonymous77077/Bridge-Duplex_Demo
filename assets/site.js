(() => {
  'use strict';
  const data = window.BRIDGE_DEMO_DATA;
  const $ = id => document.getElementById(id);
  if (!data || !Array.isArray(data.sections)) {
    $('comparison-title').textContent = 'The audio collection could not be loaded.';
    $('comparison-description').textContent = 'Please reload the page.';
    $('ready-content').hidden = true;
    return;
  }
  const state = { table: data.sections.find(section => section.samples.length)?.number ?? 2, sample: '', speed: 1, transcripts: false };
  const players = new Set();
  const playerCleanups = new Set();
  const playerPlayCancels = new Map();
  let activePlayer = null;
  const icon = (path, viewBox = '0 0 24 24') => {
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('viewBox', viewBox); svg.setAttribute('aria-hidden', 'true');
    const p = document.createElementNS(svg.namespaceURI, 'path'); p.setAttribute('d', path); svg.append(p); return svg;
  };
  const playIcon = () => icon('M7 4.5v15l12-7.5z');
  const pauseIcon = () => icon('M6 5h4v14H6zm8 0h4v14h-4z');
  const el = (tag, className, text) => {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  };
  const formatTime = value => {
    if (!Number.isFinite(value) || value < 0) return '0:00';
    const seconds = Math.floor(value);
    return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
  };
  const currentSection = () => data.sections.find(s => s.number === state.table) || data.sections[0];
  const currentSamples = () => currentSection().samples;
  const announce = message => { $('announcement').textContent = message; };
  function stopPlayers() {
    activePlayer = null;
    for (const cleanup of playerCleanups) cleanup();
    playerCleanups.clear(); playerPlayCancels.clear();
    for (const player of players) {
      player.pause(); player.removeAttribute('src'); player.load();
    }
    players.clear();
  }
  function transcript(turns, extraClass = '') {
    const box = el('div', `transcript ${extraClass}`.trim());
    box.lang = 'en';
    for (const turn of turns) {
      const row = el('p', 'transcript-turn');
      const isTwo = turn.speaker === 'System2' || turn.speaker === 'User';
      row.append(el('span', `speaker${isTwo ? ' role-two' : ''}`, turn.speaker), document.createTextNode(turn.text));
      box.append(row);
    }
    return box;
  }
  function transcriptDisclosure(turns, reference = false) {
    const details = el('details', 'transcript-details');
    details.open = reference || state.transcripts;
    if (!reference) details.dataset.modelTranscript = 'true';
    const summary = el('summary');
    summary.append(el('span', '', reference ? 'Shared reference transcript · English' : 'English ASR transcript'), el('span', 'details-plus', '＋'));
    summary.lastElementChild.setAttribute('aria-hidden', 'true');
    details.append(summary, transcript(turns, reference ? 'reference-transcript' : ''));
    if (!reference) details.addEventListener('toggle', updateTranscriptButton);
    return details;
  }
  function audioPlayer(recording, label) {
    const root = el('div', 'audio-player');
    const audio = el('audio'); audio.src = recording.url; audio.preload = 'none'; audio.playbackRate = state.speed;
    audio.setAttribute('aria-label', label);
    players.add(audio);
    const main = el('div', 'player-main');
    const button = el('button', 'play-button'); button.type = 'button'; button.setAttribute('aria-label', `Play ${label}`); button.append(playIcon());
    const track = el('div', 'wave-track');
    const waveform = el('div', 'waveform'); waveform.setAttribute('aria-hidden', 'true');
    for (const value of recording.waveform || Array(48).fill(.4)) {
      const bar = el('span'); bar.style.setProperty('--height', `${Math.max(3, Math.round(value * 31))}px`); waveform.append(bar);
    }
    const seek = el('input', 'seek-range'); seek.type = 'range'; seek.min = '0'; seek.max = String(recording.duration); seek.step = '0.05'; seek.value = '0';
    seek.setAttribute('aria-label', `Seek ${label}`); seek.setAttribute('aria-valuetext', `0:00 of ${formatTime(recording.duration)}`);
    track.append(waveform, seek); main.append(button, track);
    const bottom = el('summary', 'player-bottom');
    bottom.setAttribute('aria-label', `Audio options for ${label}`);
    const time = el('span', 'player-time', `0:00 / ${formatTime(recording.duration)}`); time.setAttribute('aria-hidden', 'true');
    const download = el('a', 'audio-download'); download.href = recording.url; download.download = `${label.replace(/[^a-z0-9]+/gi, '-').toLowerCase()}.wav`;
    download.setAttribute('aria-label', `Download ${label}`); download.title = 'Download audio';
    download.append(icon('M12 3v12m-4-4 4 4 4-4M5 16v4h14v-4'), document.createTextNode('Download WAV'));
    const open = el('a', 'audio-download', 'Open audio');
    open.href = recording.url; open.target = '_blank'; open.rel = 'noopener';
    open.setAttribute('aria-label', `Open ${label} in the browser`);
    const links = el('div', 'audio-links'); links.append(open, download);
    const optionsLabel = el('span', 'audio-options-label', 'Audio options');
    const plus = el('span', 'details-plus', '＋'); plus.setAttribute('aria-hidden', 'true');
    optionsLabel.append(plus); bottom.append(time, optionsLabel);
    const options = el('details', 'audio-options');
    const panel = el('div', 'audio-options-panel');
    panel.append(links, el('p', 'native-player-label', 'Browser player'), audio);
    options.append(bottom, panel);
    const status = el('p', 'audio-status'); status.setAttribute('role', 'status');
    const error = el('p', 'audio-error'); error.hidden = true;
    audio.controls = true;
    options.addEventListener('toggle', () => {
      // Load the duration when the user opens the native player, without
      // interrupting active playback or retrying a failed request implicitly.
      if (options.open && audio.paused && audio.readyState === 0 && !audio.error
          && audio.networkState !== HTMLMediaElement.NETWORK_LOADING) {
        audio.preload = 'metadata'; audio.load();
      }
    });
    root.append(main, options, status, error);
    let seeking = false, pendingSeek = null, seekVersion = 0;
    let disposed = false, playAfterSeek = false, bufferedLoad = null, reloadRequired = false;
    let objectURL = null, fetchController = null;
    playerPlayCancels.set(audio, () => { playAfterSeek = false; if (pendingSeek !== null) playing(false); });
    playerCleanups.add(() => {
      disposed = true; seekVersion++; playAfterSeek = false;
      if (activePlayer === audio) activePlayer = null;
      fetchController?.abort();
      if (objectURL) URL.revokeObjectURL(objectURL);
    });
    function update() {
      const duration = Number.isFinite(audio.duration) ? audio.duration : recording.duration;
      const value = pendingSeek !== null ? pendingSeek : audio.currentTime;
      if (!seeking) seek.value = String(value);
      time.textContent = `${formatTime(value)} / ${formatTime(duration)}`;
      seek.max = String(duration);
      seek.setAttribute('aria-valuetext', `${formatTime(value)} of ${formatTime(duration)}`);
      const fraction = duration ? value / duration : 0;
      [...waveform.children].forEach((bar, index) => bar.classList.toggle('played', fraction > index / waveform.children.length));
    }
    function playing(isPlaying) {
      button.replaceChildren(isPlaying ? pauseIcon() : playIcon());
      button.classList.toggle('playing', isPlaying);
      button.setAttribute('aria-label', `${isPlaying ? 'Pause' : 'Play'} ${label}`);
    }
    function seekable(value) {
      if (audio.readyState < 1) return false;
      if (value === 0) return true;
      for (let i = 0; i < audio.seekable.length; i++) {
        if (audio.seekable.start(i) <= value && audio.seekable.end(i) >= value) return true;
      }
      return false;
    }
    function claimPlayback() {
      if (disposed) return false;
      // Claim ownership at the user's click, before asynchronous media events.
      // A delayed play event from a superseded player must not stop this one.
      activePlayer = audio;
      for (const other of players) if (other !== audio) {
        playerPlayCancels.get(other)?.(); other.pause();
      }
      return true;
    }
    function playbackError(e) {
      if (disposed) return;
      if (e.name === 'AbortError') {
        // Switching players or samples intentionally aborts earlier play calls.
        if (activePlayer !== audio) return;
        reloadRequired = true; activePlayer = null; playAfterSeek = false;
        audio.pause(); playing(false);
        status.textContent = 'Playback was interrupted. Press Play to retry.';
        return;
      }
      playAfterSeek = false;
      if (activePlayer === audio) activePlayer = null;
      error.textContent = e.name === 'NotAllowedError'
        ? 'Playback was blocked. Use Browser player or Open audio in Audio options.'
        : 'Audio could not be played. Press Play to retry, or use Open audio.';
      error.hidden = false; options.open = true; status.textContent = ''; playing(false);
    }
    async function prepareSeek() {
      // Without HTTP byte ranges, metadata can expose only the first second as
      // seekable. Load the selected WAV fully before committing a later seek.
      if (!bufferedLoad && !objectURL && location.protocol !== 'file:') {
        fetchController = new AbortController();
        bufferedLoad = (async () => {
          const response = await fetch(recording.url, { signal: fetchController.signal });
          if (!response.ok) throw new Error('Audio download failed');
          const blob = await response.blob();
          if (disposed) throw new DOMException('Player closed', 'AbortError');
          objectURL = URL.createObjectURL(blob);
          audio.src = objectURL; audio.preload = 'auto'; audio.load();
          audio.playbackRate = state.speed;
        })().catch(e => { bufferedLoad = null; throw e; });
      }
      if (bufferedLoad) await bufferedLoad;
      else {
        audio.preload = 'auto';
        if (audio.readyState === 0 && audio.networkState !== HTMLMediaElement.NETWORK_LOADING) audio.load();
      }
      const deadline = Date.now() + 20000;
      while (!disposed && pendingSeek !== null) {
        const target = Math.min(pendingSeek, Number.isFinite(audio.duration) ? audio.duration : recording.duration);
        if (seekable(target)) return;
        if (audio.error || Date.now() >= deadline) throw new Error('Audio seek failed');
        await new Promise(resolve => setTimeout(resolve, 40));
      }
    }
    async function requestSeek(value) {
      const version = ++seekVersion;
      playAfterSeek = playAfterSeek || !audio.paused;
      pendingSeek = value; audio.pause(); error.hidden = true;
      status.textContent = 'Loading audio…'; playing(playAfterSeek); update();
      try {
        if (!seekable(value)) await prepareSeek();
        if (disposed || version !== seekVersion) return;
        const target = Math.min(pendingSeek, audio.duration);
        if (!seekable(target)) throw new Error('Audio seek failed');
        audio.currentTime = target;
        pendingSeek = null; update();
        const resume = playAfterSeek; playAfterSeek = false;
        if (resume && activePlayer === audio) { audio.muted = false; await audio.play(); }
        else { status.textContent = target ? 'Paused' : ''; playing(false); }
      } catch (e) {
        if (version !== seekVersion) return;
        pendingSeek = null; update(); playbackError(e);
      }
    }
    button.addEventListener('click', async () => {
      if (disposed) return;
      if (pendingSeek !== null) {
        playAfterSeek = !playAfterSeek;
        if (playAfterSeek) { claimPlayback(); audio.muted = false; }
        else if (activePlayer === audio) activePlayer = null;
        playing(playAfterSeek);
        return;
      }
      const needsReload = reloadRequired || Boolean(audio.error) || audio.networkState === HTMLMediaElement.NETWORK_NO_SOURCE;
      if (!audio.paused && !needsReload) {
        if (activePlayer === audio) activePlayer = null;
        audio.pause(); return;
      }
      error.hidden = true;
      claimPlayback();
      if (needsReload) { reloadRequired = false; audio.load(); }
      audio.muted = false;
      status.textContent = 'Loading audio…';
      try { await audio.play(); } catch (e) { playbackError(e); }
    });
    audio.addEventListener('play', () => {
      // play events are queued: paused/disposed means this request was cancelled.
      if (disposed || audio.paused) return;
      if (activePlayer !== audio) claimPlayback(); // Native browser controls.
      if (pendingSeek !== null) { playAfterSeek = true; audio.pause(); return; }
      playing(true);
    });
    audio.addEventListener('playing', () => {
      if (disposed || audio.paused || activePlayer !== audio) return;
      error.hidden = true; status.textContent = 'Playing'; playing(true);
    });
    audio.addEventListener('waiting', () => {
      if (!disposed && activePlayer === audio && !audio.paused) status.textContent = 'Loading audio…';
    });
    audio.addEventListener('pause', () => {
      if (disposed || !audio.paused) return;
      if (pendingSeek === null && activePlayer === audio) activePlayer = null;
      playing(pendingSeek !== null && playAfterSeek);
      status.textContent = pendingSeek !== null ? 'Loading audio…' : audio.currentTime ? 'Paused' : '';
    });
    audio.addEventListener('ended', () => {
      if (disposed) return;
      if (activePlayer === audio) activePlayer = null;
      playing(false); status.textContent = 'Finished'; update();
    });
    audio.addEventListener('timeupdate', update);
    audio.addEventListener('loadedmetadata', update);
    audio.addEventListener('error', () => {
      if (disposed || !audio.getAttribute('src')) return;
      const reasons = {
        1: 'Audio loading was interrupted.',
        2: 'The audio file could not be downloaded.',
        3: 'The browser could not decode this audio.',
        4: 'The audio file could not be loaded or decoded.'
      };
      error.textContent = `${reasons[audio.error?.code] || 'Audio is unavailable.'} Press Play to retry, or use Open audio.`;
      error.hidden = false; options.open = true; status.textContent = ''; playing(false);
    });
    seek.addEventListener('input', () => {
      seeking = true;
      requestSeek(Number(seek.value));
      seeking = false;
    });
    return root;
  }
  function context(sample, section) {
    const container = $('shared-context'); container.replaceChildren();
    const header = el('div', 'context-header'); const title = el('div', 'context-heading');
    title.append(icon('M4 4h6a3 3 0 0 1 3 3v14a4 4 0 0 0-4-2H4zm16 0h-5a3 3 0 0 0-2 3v14a4 4 0 0 1 4-2h3z'), document.createTextNode(section.mode === 'dialogue' ? 'Shared narrative' : 'Shared reference dialogue'));
    header.append(title, el('span', 'shared-label', 'Same for all models')); container.append(header);
    if (section.mode === 'dialogue') {
      container.append(el('p', 'narrative', sample.narrative));
      container.append(el('p', 'channel-guide', 'System1: left · System2: right. Headphones recommended.'));
      return;
    }
    container.append(el('p', 'context-help', 'Listen to the common context, including the latest user utterance. Compare the target system responses below.'));
    const layout = el('div', 'reference-layout');
    if (sample.reference.audio) layout.append(audioPlayer(sample.reference.audio, `${sample.title} shared reference`));
    else layout.style.gridTemplateColumns = '1fr';
    layout.append(transcriptDisclosure(sample.reference.transcript, true)); container.append(layout);
  }
  function modelCard(model, sample, section, index) {
    const article = el('article', `model-card${model.proposed ? ' proposed' : ''}`); article.dataset.model = model.id;
    const inside = el('div', 'model-card-inner');
    const meta = el('div', 'model-meta');
    meta.append(el('span', '', `MODEL ${String(index + 1).padStart(2, '0')}`));
    if (model.proposed) meta.append(el('span', 'model-badge', 'Proposed'));
    const title = el('h5', '', model.name); inside.append(meta, title, audioPlayer(model.audio, `${sample.title} ${model.name}`), transcriptDisclosure(model.transcript));
    article.append(inside); return article;
  }
  function updateTranscriptButton() {
    const disclosures = [...document.querySelectorAll('[data-model-transcript]')];
    const allOpen = disclosures.length > 0 && disclosures.every(d => d.open);
    $('toggle-transcripts').textContent = allOpen ? 'Hide all transcripts −' : 'Show all transcripts ＋';
    $('toggle-transcripts').setAttribute('aria-expanded', String(allOpen));
  }
  function writeLocation() {
    const hash = `#${currentSection().slug}${state.sample ? '/' + encodeURIComponent(state.sample) : ''}`;
    if (location.hash !== hash) { try { history.replaceState(null, '', hash); } catch (_) {} }
  }
  function renderSample(updateLocation = true) {
    stopPlayers();
    const section = currentSection(), samples = currentSamples();
    const sample = samples.find(s => s.id === state.sample) || samples[0];
    if (!sample) return;
    state.sample = sample.id;
    const index = samples.indexOf(sample);
    $('sample-select').value = sample.id;
    $('sample-count').textContent = `${String(index + 1).padStart(2, '0')} / ${String(samples.length).padStart(2, '0')}`;
    $('previous-sample').disabled = index === 0; $('next-sample').disabled = index === samples.length - 1;
    context(sample, section);
    $('recordings-title').textContent = section.mode === 'dialogue' ? 'Full conversations' : 'Target system responses';
    $('recordings-subtitle').textContent = `${sample.models.length} models · ${section.mode === 'dialogue' ? 'System1 / System2' : 'System'} · English ASR`;
    $('model-grid').replaceChildren(...sample.models.map((model, i) => modelCard(model, sample, section, i)));
    updateTranscriptButton();
    if (updateLocation) writeLocation();
    announce(`${section.shortTitle}. Example ${index + 1} of ${samples.length}: ${sample.title}.`);
  }
  function renderSampleOptions() {
    const samples = currentSamples();
    $('sample-select').replaceChildren(...samples.map((sample, i) => {
      const option = el('option', '', `${String(i + 1).padStart(2, '0')} · ${sample.title}`); option.value = sample.id; return option;
    }));
    renderSample();
  }
  function renderTable() {
    stopPlayers(); const section = currentSection();
    $('comparison').setAttribute('aria-labelledby', `tab-${section.number}`);
    for (const button of $('comparison-tabs').children) {
      const active = Number(button.dataset.table) === state.table;
      button.setAttribute('aria-selected', String(active)); button.tabIndex = active ? 0 : -1;
    }
    $('comparison-kicker').textContent = section.mode === 'dialogue' ? 'TWO-INSTANCE DIALOGUE' : 'MULTI-TURN SEMANTIC';
    $('comparison-title').textContent = section.title;
    $('comparison-description').textContent = section.description;
    const empty = !section.samples.length;
    $('pending').hidden = !empty; $('ready-content').hidden = empty;
    if (empty) {
      state.sample = ''; $('shared-context').replaceChildren(); $('model-grid').replaceChildren(); writeLocation();
      announce(`${section.shortTitle}. Audio examples are being prepared.`); return;
    }
    renderSampleOptions();
  }

  function changeTable(number) {
    if (number === state.table) return;
    state.table = number; state.sample = ''; renderTable();
  }
  function parseLocation() {
    const match = location.hash.match(/^#([^/]+)(?:\/([^/]+))?$/);
    if (!match) return false;
    // Keep previously shared table-number links working; new links use comparison names.
    const section = data.sections.find(s => s.slug === match[1] || `table-${s.number}` === match[1]);
    if (!section) return false;
    state.table = section.number;
    try { state.sample = match[2] ? decodeURIComponent(match[2]) : ''; } catch (_) { state.sample = ''; }
    return true;
  }
  for (const section of data.sections) {
    const button = el('button', 'comparison-tab'); button.id = `tab-${section.number}`; button.type = 'button'; button.dataset.table = section.number;
    button.setAttribute('role', 'tab'); button.setAttribute('aria-controls', 'comparison');
    button.append(el('strong', '', section.shortTitle), el('span', 'tab-corner', section.samples.length ? '↗' : '···'));
    button.lastElementChild.setAttribute('aria-hidden', 'true');
    button.addEventListener('click', () => changeTable(section.number));
    button.addEventListener('keydown', event => {
      const buttons = [...$('comparison-tabs').children]; const index = buttons.indexOf(button);
      let target;
      if (event.key === 'ArrowRight') target = buttons[(index + 1) % buttons.length];
      else if (event.key === 'ArrowLeft') target = buttons[(index - 1 + buttons.length) % buttons.length];
      else if (event.key === 'Home') target = buttons[0];
      else if (event.key === 'End') target = buttons.at(-1);
      if (target) { event.preventDefault(); target.focus(); changeTable(Number(target.dataset.table)); }
    });
    $('comparison-tabs').append(button);
  }
  $('browse-available').addEventListener('click', () => { changeTable(2); $('tab-2').focus(); });
  $('sample-select').addEventListener('change', event => { state.sample = event.target.value; renderSample(); });
  function step(delta) {
    const samples = currentSamples(), index = samples.findIndex(s => s.id === state.sample);
    const sample = samples[index + delta]; if (sample) { state.sample = sample.id; renderSample(); }
  }
  $('previous-sample').addEventListener('click', () => step(-1));
  $('next-sample').addEventListener('click', () => step(1));
  $('playback-speed').addEventListener('change', event => { state.speed = Number(event.target.value); for (const player of players) player.playbackRate = state.speed; });
  $('toggle-transcripts').addEventListener('click', () => {
    const all = [...document.querySelectorAll('[data-model-transcript]')];
    state.transcripts = !all.every(details => details.open);
    all.forEach(details => { details.open = state.transcripts; }); updateTranscriptButton();
  });
  window.addEventListener('hashchange', () => { if (parseLocation()) renderTable(); });
  const deepLink = parseLocation(); renderTable();
  if (deepLink) requestAnimationFrame(() => $('demos').scrollIntoView({ behavior: 'instant', block: 'start' }));
})();

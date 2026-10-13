/* ============ 《迷失的星星》翻书交互（真实叶片翻页 · 底层先切版） ============
 * 页面顺序：头图视频 → 0 → 1 → t1 → t2 → t3 → 2 → t4 → t5 → t6 → 3 → 4 → 5 →【全屏 6】
 *
 * 封面：点击/左拖翻开；第一页点左半 = 合书
 * 翻页：右半页点击/左拖 = 下一页；左半页点击/右拖 = 上一页
 *   - 翻页开始：底层立即溶解到目标页（右半随叶片掀起直接露出下一页）
 *   - 目标页视频只在后台缓冲，画面由 poster/定格帧兜底
 *   - 叶片正面 = 被掀起半页的定格封面（前翻=当前页右半，回翻=上一页右半）
 *   - 叶片背面 = 目标页对应半页封面，落下时与底层完全衔接
 *   - 翻页结束：叶片直接收走，目标页视频此时才开播
 *
 * 视频规则：到页自动静音播放（3/4/5 有声、默认静音，右下角半透明静音键全局互通），
 *           不循环、停尾帧；翻走暂停记忆进度，翻回继续；播完后再翻回则从开头重播；
 *           合书全部复位。
 * 片尾：5 播放至最后约 1.6 秒时整屏渐黑，随后全屏播放 6（声音开关互通）；
 *       5 上点右页或向左拖动可手动提前进入 6，转场效果相同。
 * 完整视频：6 播完出现"观看完整视频"按钮；封面页有"直接观看完整视频"入口；
 *           完整视频全屏播放（声音开关互通），页面空闲时后台预加载。
 */
(function () {
  'use strict';

  var PAGES = [
    { type: 'video', src: 'assets/hero.mp4',  poster: 'assets/poster_hero.jpg' },
    { type: 'video', src: 'assets/0.mp4',     poster: 'assets/poster_0.jpg'    },
    { type: 'video', src: 'assets/1.mp4',     poster: 'assets/poster_1.jpg'    },
    { type: 'image', src: 'assets/t1.webp',   poster: 'assets/t1.webp'         },
    { type: 'image', src: 'assets/t2.webp',   poster: 'assets/t2.webp'         },
    { type: 'image', src: 'assets/t3.webp',   poster: 'assets/t3.webp'         },
    { type: 'video', src: 'assets/2.mp4',     poster: 'assets/poster_2.jpg'    },
    { type: 'image', src: 'assets/t4.webp',   poster: 'assets/t4.webp'         },
    { type: 'image', src: 'assets/t5.webp',   poster: 'assets/t5.webp'         },
    { type: 'image', src: 'assets/t6.webp',   poster: 'assets/t6.webp'         },
    { type: 'video', src: 'assets/3.mp4',     poster: 'assets/poster_3.jpg', sound: true },
    { type: 'video', src: 'assets/4.mp4',     poster: 'assets/poster_4.jpg', sound: true },
    { type: 'video', src: 'assets/5.mp4',     poster: 'assets/poster_5.jpg', sound: true, fadeout: true }
  ];
  var N = PAGES.length;
  var FADE_IDX = N - 1;                       // 5 的索引（最后一张书页）
  var VIDEO6 = { src: 'assets/6.mp4', poster: 'assets/poster_6.jpg' };
  var FULL   = { src: 'assets/full.mp4?v=2', poster: 'assets/poster_full.jpg' };
  var FADE_AHEAD = 1.6;                       // 5 结尾提前渐黑的秒数

  var book       = document.getElementById('book');
  var spreadBase = document.getElementById('spreadBase');
  var baseSlot   = document.getElementById('baseSlot');
  var baseShade  = document.getElementById('pageShade');
  var leaf       = document.getElementById('leaf');
  var frontView  = document.getElementById('frontView');
  var backView   = document.getElementById('backView');
  var leafShades = leaf.querySelectorAll('.leaf-shade');
  var cover      = document.getElementById('coverFlip');
  var cShade     = document.getElementById('coverShade');
  var dotsBox    = document.getElementById('dots');
  var hint       = document.getElementById('hint');

  /* ---------- 每页内容：底层一份（直播） + 叶片封面一份（静态图） ---------- */
  function makeVideo(src, poster) {
    var v = document.createElement('video');
    v.src = src;
    if (poster) v.poster = poster;
    v.preload = 'metadata';   // 按需缓冲：翻到该页才升级为 auto
    v.playsInline = true;
    v.setAttribute('playsinline', '');
    v.setAttribute('muted', '');
    v.muted = true;
    return v;
  }
  function makeImg(src) {
    var im = new Image();
    im.src = src;
    im.draggable = false;
    return im;
  }

  var contents = [], clones = [], cloneImgs = [];
  var vBase = {};                    // index -> 底层 video
  var snapCanvas = document.createElement('canvas');
  var pool = document.createElement('div');

  // 半页遮盖层：翻页时用旧页面的半页盖住"晚切换"的一侧
  var overlay  = document.createElement('div');
  var ovPaper  = document.createElement('div');
  var ovView   = document.createElement('div');
  var ovSlot   = document.createElement('div');
  var ovImg    = makeImg('');
  overlay.className = 'half-overlay';
  ovPaper.className = 'ov-paper';
  ovView.className  = 'ov-view';
  ovSlot.className  = 'page-content';
  ovSlot.appendChild(ovImg);
  ovView.appendChild(ovSlot);
  overlay.appendChild(ovPaper);
  overlay.appendChild(ovView);

  function showOverlay(dir, src) {
    overlay.className = 'half-overlay ' + (dir > 0 ? 'ov-left' : 'ov-right');
    overlay.style.transition = 'none';
    overlay.style.visibility = 'visible';
    overlay.style.opacity = '1';
  }
  function hideOverlay() {
    overlay.style.transition = 'opacity .25s ease';
    overlay.style.opacity = '0';
    setTimeout(function () {
      overlay.style.visibility = 'hidden';
      overlay.style.transition = 'none';
    }, 270);
  }
  spreadBase.appendChild(overlay);

  /* ---------- 全局声音开关 + 渐黑层 + 全屏 6 ---------- */
  var soundOn = false;      // 3/4/5/6 有声页的全局开关：点一次开声，再点恢复静音
  var phase6  = false;      // 是否已进入全屏 6
  var phaseFull = false;    // 是否正在全屏播放完整视频
  var ending5 = false;      // 5 是否已触发渐黑

  var muteBtn = document.createElement('button');
  muteBtn.id = 'muteBtn';
  muteBtn.setAttribute('aria-label', '声音开关');
  var fadeEl = document.createElement('div');
  fadeEl.id = 'fadeBlack';
  var stage6 = document.createElement('div');
  stage6.id = 'stage6';
  var video6 = makeVideo(VIDEO6.src, VIDEO6.poster);
  video6.preload = 'none';  // 进入全屏阶段才加载
  stage6.appendChild(video6);
  document.body.appendChild(fadeEl);
  document.body.appendChild(stage6);
  document.body.appendChild(muteBtn);

  // 完整视频（全屏）：片尾 6 播完进入，或封面页直接观看
  var stageFull = document.createElement('div');
  stageFull.id = 'stageFull';
  var videoFull = makeVideo(FULL.src, FULL.poster);
  videoFull.preload = 'none';   // 页面空闲后后台预加载
  stageFull.appendChild(videoFull);
  document.body.appendChild(stageFull);

  // 6 播完后：观看完整视频
  var sixEnd = document.createElement('div');
  sixEnd.className = 'video-end-overlay';
  var sixEndBtn = document.createElement('button');
  sixEndBtn.className = 'pill-btn';
  sixEndBtn.textContent = '▶ 观看完整视频';
  sixEnd.appendChild(sixEndBtn);
  stage6.appendChild(sixEnd);

  // 完整视频播完后：重新播放
  var fullEnd = document.createElement('div');
  fullEnd.className = 'video-end-overlay';
  var fullEndBtn = document.createElement('button');
  fullEndBtn.className = 'pill-btn';
  fullEndBtn.textContent = '↻ 重新播放';
  fullEnd.appendChild(fullEndBtn);
  stageFull.appendChild(fullEnd);

  // 全屏加载中转圈提示（网络慢时避免"卡住"的错觉）
  var fsLoad = document.createElement('div');
  fsLoad.className = 'fs-loading';
  fsLoad.appendChild(document.createElement('i'));
  stageFull.appendChild(fsLoad);

  // B 站式播放控制条（仅完整视频）：播放/暂停 · 进度（可点可拖）· 时间 · 静音 · 全屏
  var fullCtl = document.createElement('div');
  fullCtl.id = 'fullCtl';
  var ctlPlay = document.createElement('button');
  ctlPlay.className = 'fctl-btn';
  ctlPlay.textContent = '▶';
  var ctlTime = document.createElement('span');
  ctlTime.className = 'fctl-time';
  ctlTime.textContent = '0:00 / 0:00';
  var fprog = document.createElement('div');
  fprog.className = 'fprog';
  var fbuf = document.createElement('div');
  fbuf.className = 'fprog-buf';
  var ffill = document.createElement('div');
  ffill.className = 'fprog-fill';
  var fknob = document.createElement('div');
  fknob.className = 'fprog-knob';
  fprog.appendChild(fbuf);
  fprog.appendChild(ffill);
  fprog.appendChild(fknob);
  var ctlMute = document.createElement('button');
  ctlMute.className = 'fctl-btn';
  var ctlFs = document.createElement('button');
  ctlFs.className = 'fctl-btn';
  ctlFs.textContent = '⛶';
  fullCtl.appendChild(ctlPlay);
  fullCtl.appendChild(ctlTime);
  fullCtl.appendChild(fprog);
  fullCtl.appendChild(ctlMute);
  fullCtl.appendChild(ctlFs);
  stageFull.appendChild(fullCtl);

  // 全屏退出按钮：不强制观看，随时返回书里
  function makeExitBtn() {
    var b = document.createElement('button');
    b.className = 'fs-exit';
    b.textContent = '✕';
    b.setAttribute('aria-label', '退出全屏播放');
    return b;
  }
  var sixExitBtn = makeExitBtn();
  stage6.appendChild(sixExitBtn);
  var fullExitBtn = makeExitBtn();
  stageFull.appendChild(fullExitBtn);

  // 封面入口：直接观看完整视频（不必翻完所有页）
  var fullEntry = document.createElement('button');
  fullEntry.id = 'fullEntry';
  fullEntry.textContent = '▶ 直接观看完整视频';
  document.body.appendChild(fullEntry);

  /* ---------- 底部快速翻页条：缩略图直达 + 加速翻页效果 ---------- */
  var navBar = document.createElement('div');
  navBar.id = 'navBar';
  var navPrev = document.createElement('button');
  navPrev.className = 'nav-arrow';
  navPrev.textContent = '‹';
  navPrev.setAttribute('aria-label', '上一页');
  var navNext = document.createElement('button');
  navNext.className = 'nav-arrow';
  navNext.textContent = '›';
  navNext.setAttribute('aria-label', '下一页');
  var navThumbs = document.createElement('div');
  navThumbs.id = 'navThumbs';
  var navImgs = [];
  PAGES.forEach(function (p, i) {
    var im = makeImg(p.poster);
    im.addEventListener('click', function (e) {
      e.stopPropagation();
      flipTo(i);
    });
    navThumbs.appendChild(im);
    navImgs.push(im);
  });
  navBar.appendChild(navPrev);
  navBar.appendChild(navThumbs);
  navBar.appendChild(navNext);
  document.body.appendChild(navBar);
  navPrev.addEventListener('click', function (e) {
    e.stopPropagation();
    if (mode === 'open') startTurn(-1);
  });
  navNext.addEventListener('click', function (e) {
    e.stopPropagation();
    if (mode === 'open') startTurn(1);
  });

  function syncMuteBtn() { muteBtn.textContent = soundOn ? '🔊' : '🔇'; }
  // 位置：书页阶段锚定到摊开书页的右下角内（≈视频右下角），全屏时固定屏幕右下角
  function updateMuteVis() {
    var show = !phaseFull && (phase6 || (mode === 'open' && !!PAGES[s].sound));
    muteBtn.classList.toggle('show', show);
    fullEntry.classList.toggle('show', mode === 'closed');
    navBar.classList.toggle('show', !phase6 && !phaseFull &&
      (mode === 'open' || mode === 'turning'));
    muteBtn.style.left = 'auto';
    muteBtn.style.right = 'auto';
    muteBtn.style.top = 'auto';
    muteBtn.style.bottom = 'auto';
    if (phase6 || phaseFull) {
      muteBtn.style.right = '26px';
      muteBtn.style.bottom = '24px';
    } else {
      var r = book.getBoundingClientRect();
      muteBtn.style.left = Math.round(r.right - 58) + 'px';
      muteBtn.style.top = Math.round(r.bottom - 58) + 'px';
    }
  }
  window.addEventListener('resize', updateMuteVis);
  muteBtn.addEventListener('click', function (e) {
    e.stopPropagation();
    setSound(!soundOn);
  });
  syncMuteBtn();

  PAGES.forEach(function (page, i) {
    var div = document.createElement('div');
    div.className = 'page-content';
    var cdiv = document.createElement('div');
    cdiv.className = 'page-content';
    var cim = makeImg(page.poster);  // 叶片封面图

    if (page.type === 'video') {
      var v1 = makeVideo(page.src, page.poster);
      div.appendChild(v1);
      vBase[i] = v1;
    } else {
      div.appendChild(makeImg(page.src));
    }
    cdiv.appendChild(cim);
    contents[i] = div;
    clones[i] = cdiv;
    cloneImgs[i] = cim;
  });

  /* ---------- 5 的渐黑 → 全屏 6 衔接 ---------- */
  // 手动从 5 翻到 6：渐黑后进入全屏（转场效果与自动衔接一致）
  function startEnding() {
    if (phase6 || ending5) return;
    ending5 = true;
    var v = vBase[FADE_IDX];
    if (v) v.pause();
    fadeEl.classList.add('on');
    setTimeout(enter6, 1300);
  }
  function enter6() {
    if (phase6) return;
    phase6 = true;
    mode = 'six';
    pauseAll(false);
    book.style.visibility = 'hidden';
    dotsBox.classList.remove('show');
    hint.classList.add('hidden');
    stage6.classList.add('show');
    video6.preload = 'auto';
    video6.load();       // 显式加载，避免 play() 与加载竞争被中断
    video6.muted = !soundOn;
    tryPlay(video6);
    warmFull();          // 6 起播后开始后台预加载完整视频
    updateMuteVis();
  }

  /* ---------- 完整视频（全屏） ---------- */
  var fullRetries = 0;
  var fullFrom = 'cover';   // 完整视频的进入来源：cover=封面入口，six=6 播完
  // 退出全屏视频，回到书里（toCover=true 回到合上的封面）
  function backToBook(toCover) {
    phase6 = false;
    phaseFull = false;
    ending5 = false;
    fadeEl.classList.remove('on');
    stage6.classList.remove('show');
    stageFull.classList.remove('show');
    video6.pause();
    videoFull.pause();
    sixEnd.classList.remove('show');
    fullEnd.classList.remove('show');
    fsLoad.classList.remove('show');
    book.style.visibility = '';
    if (toCover) {
      mode = 'closed';
      pc = 0;
      s = 0;
      renderCover(0);
      cover.style.opacity = '';
      setBaseContent(0);
      dotsBox.classList.remove('show');
      hint.textContent = '轻点或向左拖动 · 翻开这本书';
      hint.classList.remove('hidden');
    } else {
      mode = 'open';       // 回到第 5 页（s 仍是 FADE_IDX，页面状态保留）
      renderIdle();
      cover.style.opacity = '0';
      dotsBox.classList.add('show');
      updateDots(s);
    }
    updateMuteVis();
  }
  function warmFull() {
    if (!phaseFull && videoFull.preload !== 'auto') {
      videoFull.preload = 'auto';
      videoFull.load();  // 后台静默缓冲，点击时多半已就绪
    }
  }
  function openFull() {
    if (phaseFull) return;
    phaseFull = true;
    mode = 'full';
    pauseAll(false);
    video6.pause();
    fadeEl.classList.remove('on');
    book.style.visibility = 'hidden';
    dotsBox.classList.remove('show');
    hint.classList.add('hidden');
    stage6.classList.remove('show');
    stageFull.classList.add('show');
    if (videoFull.preload !== 'auto') {   // 后台已预载则不重置缓冲，避免 play 被中断
      videoFull.preload = 'auto';
      videoFull.load();
    }
    fullRetries = 0;
    videoFull.muted = !soundOn;
    fsLoad.classList.add('show');
    tryPlay(videoFull);
    pokeCtl();
    updateMuteVis();
  }

  /* ---------- 全局声音开关（静音键与控制条互通） ---------- */
  function setSound(on) {
    soundOn = on;
    Object.keys(vBase).forEach(function (k) {
      if (PAGES[k].sound) vBase[k].muted = !on;
    });
    video6.muted = !on;
    videoFull.muted = !on;
    syncMuteBtn();
    syncVolIcon();
  }
  function syncVolIcon() { ctlMute.textContent = soundOn ? '🔊' : '🔇'; }
  syncVolIcon();

  /* ---------- 完整视频播放控制条 ---------- */
  function fmtT(t) {
    t = Math.max(0, Math.floor(t || 0));
    var m = Math.floor(t / 60), s = t % 60;
    return m + ':' + (s < 10 ? '0' : '') + s;
  }
  function syncCtlTime() {
    ctlTime.textContent = fmtT(videoFull.currentTime) + ' / ' + fmtT(videoFull.duration);
  }
  function syncProg(previewP) {
    var p = previewP != null ? previewP :
      (videoFull.duration ? videoFull.currentTime / videoFull.duration : 0);
    p = Math.min(1, Math.max(0, p));
    ffill.style.width = (p * 100).toFixed(2) + '%';
    fknob.style.left = (p * 100).toFixed(2) + '%';
    try {
      if (videoFull.buffered.length && videoFull.duration) {
        fbuf.style.width = (videoFull.buffered.end(videoFull.buffered.length - 1) /
          videoFull.duration * 100).toFixed(2) + '%';
      }
    } catch (e) {}
  }
  function syncPlayIcon() {
    ctlPlay.textContent = (videoFull.paused || videoFull.ended) ? '▶' : '❚❚';
  }
  function toggleFullPlay() {
    if (videoFull.ended) {
      try { videoFull.currentTime = 0; } catch (e) {}
      fullEnd.classList.remove('show');
    }
    if (videoFull.paused) { videoFull.muted = !soundOn; tryPlay(videoFull); }
    else videoFull.pause();
  }
  ctlPlay.addEventListener('click', function (e) { e.stopPropagation(); toggleFullPlay(); });
  ctlMute.addEventListener('click', function (e) { e.stopPropagation(); setSound(!soundOn); });
  ctlFs.addEventListener('click', function (e) {
    e.stopPropagation();
    if (document.fullscreenElement) { document.exitFullscreen(); }
    else if (stageFull.requestFullscreen) { stageFull.requestFullscreen(); }
  });
  videoFull.addEventListener('click', function (e) { e.stopPropagation(); toggleFullPlay(); });

  // 进度条：点击/拖动跳转
  var seeking = false;
  function progPos(clientX) {
    var r = fprog.getBoundingClientRect();
    return Math.min(1, Math.max(0, (clientX - r.left) / r.width));
  }
  fprog.addEventListener('pointerdown', function (e) {
    e.stopPropagation();
    seeking = true;
    fprog.setPointerCapture(e.pointerId);
    syncProg(progPos(e.clientX));
  });
  fprog.addEventListener('pointermove', function (e) {
    if (seeking) syncProg(progPos(e.clientX));
  });
  fprog.addEventListener('pointerup', function (e) {
    if (!seeking) return;
    seeking = false;
    var p = progPos(e.clientX);
    if (videoFull.duration) { try { videoFull.currentTime = p * videoFull.duration; } catch (err) {} }
    syncProg();
    syncCtlTime();
  });
  videoFull.addEventListener('timeupdate', function () {
    if (!seeking) syncProg();
    syncCtlTime();
    syncPlayIcon();
  });
  videoFull.addEventListener('progress', function () { syncProg(); });
  videoFull.addEventListener('play', syncPlayIcon);
  videoFull.addEventListener('pause', syncPlayIcon);

  // 控制条自动隐藏：播放时 3 秒无操作隐藏，暂停/结束时常驻
  var ctlTimer = null;
  function pokeCtl() {
    fullCtl.classList.add('show');
    if (ctlTimer) clearTimeout(ctlTimer);
    if (!videoFull.paused && !videoFull.ended) {
      ctlTimer = setTimeout(function () { fullCtl.classList.remove('show'); }, 3000);
    }
  }
  stageFull.addEventListener('mousemove', pokeCtl);
  stageFull.addEventListener('touchstart', pokeCtl, { passive: true });
  var v5 = vBase[FADE_IDX];
  if (v5) {
    // 播放到尾声时整屏渐黑，给全屏 6 做转场
    v5.addEventListener('timeupdate', function () {
      if (phase6 || v5.paused || !v5.duration) return;
      if (!ending5 && v5.duration - v5.currentTime <= FADE_AHEAD) {
        ending5 = true;
        fadeEl.classList.add('on');
      }
    });
    v5.addEventListener('ended', function () { enter6(); });
  }
  video6.addEventListener('playing', function () {
    sixEnd.classList.remove('show');
    setTimeout(function () { fadeEl.classList.remove('on'); }, 250);
  });
  video6.addEventListener('canplay', function () {
    if (phase6 && video6.paused && !video6.ended) tryPlay(video6);  // 兜底重试
  });
  video6.addEventListener('ended', function () {
    video6.pause();                  // 定格尾帧
    sixEnd.classList.add('show');    // 给出"观看完整视频"入口
  });

  // 6 播完 → 完整视频
  sixEndBtn.addEventListener('click', function (e) {
    e.stopPropagation();
    fullFrom = 'six';
    openFull();
  });
  // 封面页 → 直接观看完整视频（渐黑转场，与书内效果一致）
  fullEntry.addEventListener('click', function (e) {
    e.stopPropagation();
    if (phaseFull) return;
    fullFrom = 'cover';
    fadeEl.classList.add('on');
    setTimeout(openFull, 900);
  });
  // 退出全屏：6 → 回第 5 页；完整视频 → 按来源回封面或第 5 页
  sixExitBtn.addEventListener('click', function (e) {
    e.stopPropagation();
    backToBook(false);
  });
  fullExitBtn.addEventListener('click', function (e) {
    e.stopPropagation();
    backToBook(fullFrom === 'cover');
  });
  // 完整视频播完 → 重新播放
  fullEndBtn.addEventListener('click', function (e) {
    e.stopPropagation();
    try { videoFull.currentTime = 0; } catch (err) {}
    fullEnd.classList.remove('show');
    tryPlay(videoFull);
  });
  videoFull.addEventListener('playing', function () {
    fullEnd.classList.remove('show');
    fsLoad.classList.remove('show');
    syncPlayIcon();
    pokeCtl();
    setTimeout(function () { fadeEl.classList.remove('on'); }, 250);
  });
  videoFull.addEventListener('canplay', function () {
    if (phaseFull && videoFull.paused && !videoFull.ended) tryPlay(videoFull);
  });
  videoFull.addEventListener('ended', function () {
    videoFull.pause();
    fsLoad.classList.remove('show');
    fullEnd.classList.add('show');
    fullCtl.classList.add('show');   // 结束时常驻控制条
    syncPlayIcon();
    syncCtlTime();
    syncProg();
  });
  // 网络错误自动重试（最多 3 次）
  videoFull.addEventListener('error', function () {
    if (!phaseFull || fullRetries >= 3) return;
    fullRetries++;
    setTimeout(function () {
      if (!phaseFull || !videoFull.paused) return;
      videoFull.load();
      videoFull.muted = !soundOn;
      tryPlay(videoFull);
    }, 1500);
  });

  /* ---------- 页码指示点 ---------- */
  var dotEls = [];
  for (var i = 0; i < N; i++) {
    var d = document.createElement('i');
    dotsBox.appendChild(d);
    dotEls.push(d);
  }
  function updateDots(idx) {
    dotEls.forEach(function (el, k) { el.classList.toggle('on', k === idx); });
    navImgs.forEach(function (im, k) { im.classList.toggle('on', k === idx); });
  }

  /* ---------- 状态 ---------- */
  var mode = 'closed';    // closed | opening | open | turning | closing | six
  var pc = 0;             // 封面开合 0..1
  var s = 0;              // 当前页索引
  var turn = null;        // {dir, from, to, q}
  var hasTurned = false;

  /* ---------- 视频控制 ---------- */
  // 有声播放被浏览器自动播放策略拦截时：退回静音播，并同步回静音状态
  function tryPlay(v) {
    var pr = v.play();
    if (pr && pr.catch) pr.catch(function () {
      if (!v.muted) {
        v.muted = true;
        var pr2 = v.play();
        if (pr2 && pr2.catch) pr2.catch(function () {});
        soundOn = false;
        syncMuteBtn();
      }
    });
  }
  function playBase(i) {
    var v = vBase[i];
    if (!v) return;
    if (v.ended) { try { v.currentTime = 0; } catch (e) {} }
    v.muted = !(PAGES[i].sound && soundOn);
    tryPlay(v);
  }
  function pauseBase(i) { var v = vBase[i]; if (v) v.pause(); }
  // 按需升级缓冲：翻到该页（或开书到该页）时才开始拉视频数据
  function warmBase(i) {
    var v = vBase[i];
    if (v && v.preload !== 'auto') { v.preload = 'auto'; v.load(); }
  }

  // 视频页当前帧快照（作为叶片正面封面，与底层画面衔接）
  function snapshotFor(i) {
    var v = vBase[i];
    if (!v) return PAGES[i].poster;
    try {
      if (v.readyState >= 2 && v.videoWidth) {
        if (snapCanvas.width !== v.videoWidth) {
          snapCanvas.width = v.videoWidth;
          snapCanvas.height = v.videoHeight;
        }
        snapCanvas.getContext('2d').drawImage(v, 0, 0);
        return snapCanvas.toDataURL('image/jpeg', 0.85);
      }
    } catch (e) {}
    return PAGES[i].poster;
  }

  function pauseAll(reset) {
    Object.keys(vBase).forEach(function (k) {
      vBase[k].pause();
      if (reset) { try { vBase[k].currentTime = 0; } catch (e) {} }
    });
  }

  /* ---------- 基础绘制 ---------- */
  function smooth(a, b, x) {
    var t = Math.min(1, Math.max(0, (x - a) / (b - a)));
    return t * t * (3 - 2 * t);
  }
  function easeInOutCubic(t) {
    return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
  }

  function setBaseContent(idx) {
    while (baseSlot.firstChild) pool.appendChild(baseSlot.firstChild);
    contents[idx].style.opacity = '';
    baseSlot.appendChild(contents[idx]);
  }

  function renderCover(p) {
    var angle = -180 * p;
    var lift = Math.sin(p * Math.PI) * 30;
    cover.style.transform =
      'translateX(-50%) translateZ(' + lift.toFixed(1) + 'px) rotateY(' + angle.toFixed(2) + 'deg)';
    cover.style.opacity = p <= 0.42 ? 1 : Math.max(0, 1 - (p - 0.42) / 0.2);
    cShade.style.opacity = (Math.sin(p * Math.PI) * 0.45).toFixed(3);

    var so = smooth(0.08, 0.55, p);
    spreadBase.style.opacity = so.toFixed(3);
    spreadBase.style.transform = 'scale(' + (0.955 + 0.045 * so).toFixed(4) + ')';
    spreadBase.style.filter = 'brightness(' + (0.55 + 0.45 * so).toFixed(3) + ')';
    baseShade.style.opacity = (1 - smooth(0.35, 0.85, p)).toFixed(3);
  }

  function renderIdle() {
    spreadBase.style.opacity = '1';
    spreadBase.style.transform = 'scale(1)';
    spreadBase.style.filter = 'brightness(1)';
    baseShade.style.opacity = '0';
  }

  /* ---------- 叶片绘制 ---------- */
  // 前翻：rotY 0→-180（右半页向左翻）；回翻：-180→0（同一叶片反向播回）
  function renderLeaf() {
    var q = turn.q;
    var rot = turn.dir > 0 ? -180 * q : -180 * (1 - q);
    leaf.style.transform = 'rotateY(' + rot.toFixed(2) + 'deg)';
    var sh = (Math.sin(q * Math.PI) * 0.55).toFixed(3);
    leafShades[0].style.opacity = sh;
    leafShades[1].style.opacity = sh;
    baseShade.style.opacity = (Math.sin(q * Math.PI) * 0.22).toFixed(3);
  }

  /* ---------- 封面开合 ---------- */
  function animateCover(to, dur, done) {
    var from = pc, start = performance.now();
    function tick(now) {
      var t = Math.min(1, (now - start) / dur);
      pc = from + (to - from) * easeInOutCubic(t);
      renderCover(pc);
      if (t < 1) requestAnimationFrame(tick);
      else { pc = to; renderCover(pc); if (done) done(); }
    }
    requestAnimationFrame(tick);
  }

  function openBook() {
    if (mode !== 'closed') return;
    mode = 'opening';
    setBaseContent(s);
    warmBase(s);
    animateCover(1, 1250, function () {
      mode = 'open';
      renderIdle();
      cover.style.opacity = '0';
      playBase(s);
      updateMuteVis();
      dotsBox.classList.add('show');
      updateDots(s);
      hint.textContent = '点击右页 · 翻下一页　｜　点击左页 · 返回';
    });
  }

  function closeBook() {
    if (mode !== 'open') return;
    mode = 'closing';
    pauseAll(false);
    updateMuteVis();
    cover.style.opacity = '';
    dotsBox.classList.remove('show');
    animateCover(0, 1100, function () {
      mode = 'closed';
      s = 0;
      setBaseContent(0);
      pauseAll(true);
      updateMuteVis();   // 封面入口按钮重新出现
      hint.textContent = '轻点或向左拖动 · 翻开这本书';
      if (hasTurned) hint.classList.remove('hidden');
    });
  }

  // 底层内容溶解切换（翻页开始时把底层换到目标页）
  function crossfadeBase(fromEl, toEl, dur) {
    if (toEl.parentNode !== baseSlot) {
      toEl.style.opacity = '0';
      baseSlot.appendChild(toEl);
    }
    var start = performance.now();
    function tick(now) {
      var t = Math.min(1, (now - start) / dur);
      var o = easeInOutCubic(t);
      fromEl.style.opacity = String(1 - o);
      toEl.style.opacity = String(o);
      if (t < 1) requestAnimationFrame(tick);
      else {
        if (fromEl.parentNode === baseSlot) pool.appendChild(fromEl);
        fromEl.style.opacity = '';
        toEl.style.opacity = '';
      }
    }
    requestAnimationFrame(tick);
  }

  /* ---------- 翻页 ---------- */
  // chain：翻完后的回调（快速连翻用）；quick=true 时加速动画、跳过半页遮盖
  function startTurn(dir, chain, quick) {
    if (mode !== 'open') return;
    var to = s + dir;
    if (dir > 0 && to > N - 1) {                     // 最后一页再往前 = 手动进入片尾全屏 6
      if (s === FADE_IDX) startEnding();
      return;
    }
    if (dir < 0 && to < 0) { closeBook(); return; }  // 首页向左 = 合书
    mode = 'turning';
    var from = s;
    turn = { dir: dir, from: from, to: to, q: 0, quick: !!quick, chain: chain || null };

    // 叶片固定在中线右侧、绕书脊翻转；回翻只是同一动画反向播放
    leaf.style.left = '50%';
    if (dir > 0) {
      // 前翻：正面=当前页右半定格（被掀起的页），背面=下一页左半封面
      frontView.appendChild(clones[from]);
      backView.appendChild(clones[to]);
      cloneImgs[from].src = snapshotFor(from);
      cloneImgs[to].src = PAGES[to].poster;
    } else {
      // 回翻：背面=当前页左半定格（起始时叶片镜像在左半），正面=上一页右半封面
      frontView.appendChild(clones[to]);
      backView.appendChild(clones[from]);
      cloneImgs[to].src = PAGES[to].poster;
      cloneImgs[from].src = snapshotFor(from);
    }
    pauseBase(from);
    if (from === FADE_IDX) { ending5 = false; fadeEl.classList.remove('on'); }

    // 底层立刻溶解到目标页：被叶片掀起的那半页下直接露出目标页内容
    crossfadeBase(contents[from], contents[to], 200);
    warmBase(to);        // 目标页视频后台缓冲，画面由 poster/定格帧兜底
    updateDots(to);
    // 另一半页先用旧页面盖住，等翻页 70% 左右再淡出（左右互不串味）
    // 快速连翻时跳过遮盖：速度太快，直接整体切换更有"哗哗翻书"感
    if (!quick) {
      ovImg.src = PAGES[from].type === 'video' ? snapshotFor(from) : PAGES[from].poster;
      showOverlay(dir);
      turn.ovHidden = false;
    } else {
      turn.ovHidden = true;
    }

    leaf.style.visibility = 'visible';
    renderLeaf();
    animateLeaf();
  }

  var SWAP_Q = 0.7;         // 遮盖半页的淡出点：叶片扫过 70% 时新旧页面交接

  function animateLeaf() {
    var start = performance.now(), dur = turn.quick ? 230 : 850;
    function tick(now) {
      var t = Math.min(1, (now - start) / dur);
      turn.q = easeInOutCubic(t);
      if (!turn.ovHidden && turn.q >= SWAP_Q) {
        turn.ovHidden = true;
        hideOverlay();
      }
      renderLeaf();
      if (t < 1) requestAnimationFrame(tick);
      else finishTurn();
    }
    requestAnimationFrame(tick);
  }

  function finishTurn() {
    var from = turn.from, to = turn.to, chain = turn.chain;
    if (!turn.ovHidden) hideOverlay();   // 兜底
    // 底层已切到目标页，叶片两面内容与之完全衔接，直接收走
    leaf.style.visibility = 'hidden';
    leaf.style.transform = 'rotateY(0deg)';
    leafShades[0].style.opacity = '0';
    leafShades[1].style.opacity = '0';
    // 叶片上的封面收回到停车场
    if (clones[from].parentNode) pool.appendChild(clones[from]);
    if (clones[to].parentNode) pool.appendChild(clones[to]);
    pauseBase(from);
    playBase(to);        // 翻页动画完全结束后，目标页视频才开播
    if (to === FADE_IDX) { ending5 = false; fadeEl.classList.remove('on'); }
    renderIdle();
    s = to;
    turn = null;
    mode = 'open';
    updateDots(s);
    updateMuteVis();     // 必须在 s/mode 更新之后调用
    if (!hasTurned) { hasTurned = true; hint.classList.add('hidden'); }
    // 快速连翻：到达目标页收工，否则继续下一步
    if (flipTarget != null && s === flipTarget) { flipping = false; flipTarget = null; }
    if (chain) setTimeout(chain, 40);
  }

  /* ---------- 快速翻页：底部缩略图直达，中间页加速连翻 ---------- */
  var flipping = false, flipTarget = null;
  function flipTo(idx) {
    if (phase6 || phaseFull) return;
    if (idx === s) return;
    if (mode !== 'open' && mode !== 'turning') return;
    flipTarget = idx;
    if (!flipping) {
      flipping = true;
      stepFlip();
    }
  }
  function stepFlip() {
    if (flipTarget == null) { flipping = false; return; }
    if (s === flipTarget) { flipping = false; flipTarget = null; return; }
    var dir = flipTarget > s ? 1 : -1;
    var last = (s + dir === flipTarget);   // 最后一步正常速度落下并开播视频
    startTurn(dir, function () { setTimeout(stepFlip, 30); }, !last);
  }

  /* ---------- 交互：点击 + 拖动 ---------- */
  var dragging = false;
  var downX = 0, downTime = 0, moved = false;

  book.addEventListener('pointerdown', function (e) {
    if (mode !== 'closed' && mode !== 'open') return;
    dragging = true;
    moved = false;
    downX = e.clientX;
    downTime = performance.now();
    book.setPointerCapture(e.pointerId);
  });

  book.addEventListener('pointermove', function (e) {
    if (dragging && Math.abs(e.clientX - downX) > 6) moved = true;
  });

  function endDrag(e) {
    if (!dragging) return;
    dragging = false;
    var dx = e.clientX - downX;
    var quick = performance.now() - downTime < 300;

    if (mode === 'closed') {
      if ((quick && Math.abs(dx) < 8) || dx < -40) openBook();
    } else if (mode === 'open') {
      var rect = book.getBoundingClientRect();
      var rightHalf = downX > rect.left + rect.width / 2;
      if (quick && Math.abs(dx) < 8) {
        startTurn(rightHalf ? 1 : -1);
      } else if (dx < -50) {
        startTurn(1);
      } else if (dx > 50) {
        startTurn(-1);
      }
    }
  }

  book.addEventListener('pointerup', endDrag);
  book.addEventListener('pointercancel', endDrag);
  book.addEventListener('dragstart', function (e) { e.preventDefault(); });

  /* ---------- 初始化：预载全部封面图；视频只取 metadata，翻到才升级缓冲 ---------- */
  setBaseContent(0);
  renderCover(0);
  updateMuteVis();
  // 页面加载完空闲 1.5 秒后开始后台预加载完整视频
  if (document.readyState === 'complete') setTimeout(warmFull, 1500);
  else window.addEventListener('load', function () { setTimeout(warmFull, 1500); });
  PAGES.forEach(function (p) {
    var a = new Image(); a.src = p.poster;
    if (p.type === 'image') { var b = new Image(); b.src = p.src; }
  });

  /* ---------- 调试参数 ---------- */
  // ?s=N 直接停在第 N 页（0 起）
  // ?turn=0.5 前翻进行到 q 的画面；?turnback=0.5 回翻进行到 q 的画面
  var qs = new URLSearchParams(location.search);
  if (qs.get('s') !== null || qs.get('turn') !== null || qs.get('turnback') !== null) {
    var idx = Math.min(N - 1, Math.max(0, parseInt(qs.get('s') || '0', 10) || 0));
    s = idx;
    mode = 'open';
    pc = 1;
    renderCover(1);
    cover.style.opacity = '0';
    renderIdle();
    setBaseContent(s);
    dotsBox.classList.add('show');
    updateDots(s);
    hint.classList.add('hidden');
    updateMuteVis();
    if (qs.get('turn') !== null) {
      var q = Math.min(1, Math.max(0, parseFloat(qs.get('turn')) || 0));
      var toF = Math.min(N - 1, s + 1);
      turn = { dir: 1, from: s, to: toF, q: q };
      setBaseContent(toF);   // 底层翻页开始即切到目标页
      if (q < SWAP_Q) {      // 左半页仍被旧页面盖住
        ovImg.src = PAGES[s].poster;
        showOverlay(1);
      }
      leaf.style.left = '50%';
      frontView.appendChild(clones[s]);
      backView.appendChild(clones[toF]);
      cloneImgs[s].src = PAGES[s].poster;
      cloneImgs[toF].src = PAGES[toF].poster;
      leaf.style.visibility = 'visible';
      renderLeaf();
      mode = 'frozen';
    } else if (qs.get('turnback') !== null) {
      var qb = Math.min(1, Math.max(0, parseFloat(qs.get('turnback')) || 0));
      var toB = Math.max(0, s - 1);
      turn = { dir: -1, from: s, to: toB, q: qb };
      setBaseContent(toB);   // 底层翻页开始即切到目标页
      if (qb < SWAP_Q) {     // 右半页仍被旧页面盖住
        ovImg.src = PAGES[s].poster;
        showOverlay(-1);
      }
      leaf.style.left = '50%';
      frontView.appendChild(clones[toB]);
      backView.appendChild(clones[s]);
      cloneImgs[s].src = PAGES[s].poster;
      cloneImgs[toB].src = PAGES[toB].poster;
      leaf.style.visibility = 'visible';
      renderLeaf();
      mode = 'frozen';
    } else {
      playBase(s);
    }
  }

  // ?six=1 直接进入全屏 6（调试用）
  if (qs.get('six') !== null) setTimeout(enter6, 500);
  // ?full=1 直接进入完整视频（调试用）
  if (qs.get('full') !== null) setTimeout(openFull, 500);

  // ?s=N&auto=1 自动执行一次真实翻页（auto=-1 回翻），用于复现收尾状态
  if (qs.get('auto') !== null) {
    var dirA = parseInt(qs.get('auto'), 10) || 1;
    window.__playLog = [];
    document.addEventListener('play', function (e) {
      var name = e.target.currentSrc ? e.target.currentSrc.split('/').pop() : '?';
      window.__playLog.push(name + '@' + performance.now().toFixed(0));
    }, true);
    setTimeout(function () { startTurn(dirA); }, 800);
    setInterval(function () {
      document.title = 'm=' + mode + ' s=' + s + ' q=' + (turn ? turn.q.toFixed(2) : '-') +
        ' leaf=' + leaf.style.visibility + ' baseKids=' + baseSlot.children.length +
        ' p6=' + phase6 + ' pF=' + phaseFull +
        ' plays=' + JSON.stringify(window.__playLog);
    }, 200);
  }
})();

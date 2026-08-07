/* ============================================================
   ux.js ― 画面の使い勝手を良くするための追加処理（ver0.5.9.2 向け）

   【このファイルの立ち位置】
   csv.js / algorithm.js / ui.js には一切手を入れない「上乗せ層」。
   index.html の <script> と <link> を1行ずつ外せば、元の画面に戻せる。

   そのため、このファイルは次の3つしかしていない。
     (1) 既存の要素を「別の場所へ移す」   … ノードごと動かすので、
                                             ui.js が持っている参照
                                             （els.dateSelect など）も、
                                             登録済みのイベントも生きたまま。
     (2) 既存の要素を「見て」画面に写す   … MutationObserver で読むだけ。
                                             ui.js の処理には触らない。
     (3) 新しい要素（.ux-*）を足す
   既存の ID・クラス名は変更・削除しない。ui.js は getElementById で
   要素を取るため、DOM上の位置が変わっても動作は変わらない。

   【何を解決したか】
   14型ノート（実質 1280×720 前後）では、元の画面は縦に約4画面ぶんあった。
   とくに「印刷する」「配置違反チェック」は最下部の④夜勤パネル末尾にあり、
   座席表を見ながら押すことができなかった。
     ・主要な操作を上部の固定バーへ集約（スクロールなしで押せる）
     ・日勤／夜勤をタブで切り替え（縦の長さがおよそ半分）
     ・座席表ができたら①読み込み欄を1行に畳む
     ・②メッセージ欄も畳める（赤・オレンジが出たときは自動で開く）
     ・ヘルプのトグルを横並びに（パネルごとに2〜3行ぶん節約）
     ・コンパクト表示（縦の余白だけを詰める。横幅は変えない）
   ============================================================ */

(function () {
  'use strict';

  var byId = function (id) { return document.getElementById(id); };

  // ---------- 設定の保存 ----------
  // file:// で開く運用のため localStorage が使えない環境もありうる。
  // 読み書きの失敗は「設定を覚えないだけ」として黙って捨てる。
  var STORE_KEY = 'seatTool.ux.v1';
  function loadPrefs() {
    try { return JSON.parse(localStorage.getItem(STORE_KEY)) || {}; }
    catch (e) { return {}; }
  }
  function savePrefs() {
    try { localStorage.setItem(STORE_KEY, JSON.stringify(prefs)); }
    catch (e) { /* 保存できなくても動作には影響しない */ }
  }
  var prefs = loadPrefs();

  // ---------- パネルの特定 ----------
  // 見出しの文言ではなく、中にある固有IDから逆引きする。文言が変わっても壊れない。
  function panelOf(el) { return el ? el.closest('.panel') : null; }
  var setupPanel = panelOf(byId('file-shift'));
  var msgPanel = byId('messages-panel');
  var dayPanel = panelOf(byId('seat-grid'));
  var nightPanel = panelOf(byId('night-seat-grid'));
  if (!setupPanel || !msgPanel || !dayPanel || !nightPanel) return; // 構成が想定と違えば何もしない
  dayPanel.id = 'ux-panel-day';
  nightPanel.id = 'ux-panel-night';

  var datePickerRow = byId('date-select').closest('.date-picker-row');
  var runActions = byId('btn-run').closest('.actions');
  var mainActions = byId('btn-check').closest('.actions');
  var messages = byId('messages');

  // ---------- 上部固定バーを組み立てる ----------
  var bar = document.createElement('div');
  bar.className = 'ux-bar';
  bar.setAttribute('role', 'toolbar');
  bar.setAttribute('aria-label', '主要な操作');
  var inner = document.createElement('div');
  inner.className = 'ux-bar-inner';
  bar.appendChild(inner);
  document.body.insertBefore(bar, document.body.firstChild);

  function addSep() {
    var s = document.createElement('div');
    s.className = 'ux-sep';
    inner.appendChild(s);
  }
  function makeBtn(label, title) {
    var b = document.createElement('button');
    b.type = 'button';
    b.className = 'ux-btn';
    if (label) b.textContent = label;
    if (title) b.title = title;
    return b;
  }
  // メッセージ件数の目印（バー・②見出しの2か所で同じものを使う）
  function makeFlags() {
    var f = document.createElement('span');
    f.className = 'ux-flags';
    return f;
  }

  var brand = document.createElement('div');
  brand.className = 'ux-brand';
  brand.textContent = '座席配置ツール';
  inner.appendChild(brand);
  addSep();

  // 「配置対象日」と「自動配置を実行」を、パネル①からバーへ移設。
  // ノードごと動かすので、change / click のイベントはそのまま生きている。
  inner.appendChild(datePickerRow);
  inner.appendChild(runActions);
  addSep();

  var navMsg = makeBtn('メッセージ', '「2. メッセージ」欄を開いて、そこまで移動します（Alt+2）');
  var barFlags = makeFlags();
  navMsg.appendChild(barFlags);
  inner.appendChild(navMsg);
  addSep();

  var tabDay = makeBtn('日勤', '「3. 日勤 座席配置」だけを表示します（Alt+3）');
  var tabNight = makeBtn('夜勤', '「4. 夜勤 座席配置」だけを表示します（Alt+4）');
  var tabBoth = makeBtn('両方', '日勤と夜勤を並べて表示します。日勤⇔夜勤のドラッグ移動もできます（Alt+0）');
  inner.appendChild(tabDay);
  inner.appendChild(tabNight);
  inner.appendChild(tabBoth);

  var spacer = document.createElement('div');
  spacer.className = 'ux-spacer';
  inner.appendChild(spacer);

  // チェック／印刷／保存／読み込みを、パネル④の末尾からバーへ移設。
  // 座席表を見ながら押せるようにするのが目的。
  inner.appendChild(mainActions);
  // 2行組みボタンは、狭い画面では1行目（「手動変更後」など）をCSSで隠すため、
  // 元の文言をそのまま title（マウスを乗せたときの説明）に入れて補う。
  ['btn-check', 'btn-print', 'btn-save', 'btn-load'].forEach(function (id) {
    var b = byId(id);
    if (b && !b.title) b.title = (b.textContent || '').replace(/\s+/g, '');
  });

  addSep();
  var densityBtn = makeBtn('コンパクト', '');
  inner.appendChild(densityBtn);

  // バーの実測の高さをCSS変数へ。ボタンが2行に折り返しても本文が隠れない。
  function syncBarHeight() {
    document.documentElement.style.setProperty('--ux-bar-h', bar.offsetHeight + 'px');
  }
  window.addEventListener('resize', syncBarHeight);

  // ---------- パネルを畳めるようにする共通処理 ----------
  // 見出し（h2）だけ残し、その下をまとめて隠す。見出しのクリックで開閉する。
  function makeCollapsible(panel) {
    var h2 = panel.querySelector('h2');
    var box = document.createElement('div');
    box.className = 'ux-collapsible';
    while (h2.nextSibling) box.appendChild(h2.nextSibling);
    panel.appendChild(box);

    var mark = document.createElement('span');
    mark.className = 'ux-fold';
    h2.appendChild(mark);
    h2.classList.add('ux-foldable');
    h2.setAttribute('role', 'button');
    h2.setAttribute('tabindex', '0');
    h2.title = 'クリックで開閉します';

    var api = {
      box: box,
      isOpen: function () { return !box.hidden; },
      set: function (open) {
        box.hidden = !open;
        mark.textContent = open ? '▾' : '▸';
        h2.setAttribute('aria-expanded', String(open));
        syncBarHeight();
      },
      toggle: function () { api.set(!api.isOpen()); }
    };
    h2.addEventListener('click', api.toggle);
    h2.addEventListener('keydown', function (e) {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); api.toggle(); }
    });
    api.set(true);
    return api;
  }

  // ---------- ①CSV読み込みパネル ----------
  var setupFold = makeCollapsible(setupPanel);

  // 畳んでいるあいだ、何を読み込めているかは1行の要約で示す。
  var summary = document.createElement('div');
  summary.className = 'ux-setup-summary';
  var chips = {};
  [['shift', 'シフト'], ['ojt', 'OJT'], ['rookie', '新人'], ['secret', '配慮']].forEach(function (pair) {
    var c = document.createElement('span');
    c.className = 'ux-chip';
    var mark = document.createElement('span');
    mark.className = 'ux-chip-mark';
    mark.textContent = '－';
    c.appendChild(mark);
    c.appendChild(document.createTextNode(pair[1]));
    summary.appendChild(c);
    chips[pair[0]] = { el: c, mark: mark };
  });
  var setupOpenBtn = makeBtn('ファイルを読み込む', 'CSV読み込み欄を開きます');
  summary.appendChild(setupOpenBtn);
  setupPanel.insertBefore(summary, setupFold.box);
  setupOpenBtn.addEventListener('click', function () { setupFold.set(true); });

  var setupSet = setupFold.set;
  setupFold.set = function (open) {
    setupSet(open);
    summary.hidden = open;
  };
  setupFold.set(true);

  // 読み込み状況を、既存の #status-* から写し取る。
  // ui.js は読み込み成功で class="empty" を外し、失敗すると付け直す。
  function refreshChips() {
    Object.keys(chips).forEach(function (key) {
      var src = byId('status-' + key);
      if (!src) return;
      var text = (src.textContent || '').trim();
      var loaded = !src.classList.contains('empty');
      var failed = !loaded && text !== '' && text !== '未読み込み';
      var c = chips[key];
      c.el.classList.toggle('is-loaded', loaded);
      c.el.classList.toggle('is-failed', failed);
      c.mark.textContent = loaded ? '✓' : (failed ? '×' : '－');
      c.el.title = text;
    });
  }
  Object.keys(chips).forEach(function (key) {
    var src = byId('status-' + key);
    if (!src) return;
    new MutationObserver(refreshChips).observe(src, {
      childList: true, characterData: true, subtree: true,
      attributes: true, attributeFilter: ['class']
    });
  });
  refreshChips();

  // 畳んでいるあいだ、CSVのドロップ先（#csv-dropzone）も一緒に隠れてしまう。
  // ファイルをウィンドウへ持ち込んだ時点で読み込み欄を開き直し、そこまで
  // 画面を送っておく（ドロップ先が見えないまま手を離す事故を防ぐ）。
  // 座席カードのドラッグでは dataTransfer に 'Files' が入らないため、
  // 手動での席替え中にここが動くことはない。
  var fileDragOpened = false;
  document.addEventListener('dragover', function (e) {
    var types = e.dataTransfer && e.dataTransfer.types;
    if (!types || Array.prototype.indexOf.call(types, 'Files') < 0) return;
    if (fileDragOpened || setupFold.isOpen()) return;
    fileDragOpened = true;
    setupFold.set(true);
    setupPanel.scrollIntoView({ block: 'start' });
  });
  ['dragend', 'drop', 'dragleave'].forEach(function (type) {
    document.addEventListener(type, function () { fileDragOpened = false; });
  });

  // 座席表ができたら読み込み欄を畳む。
  // 「実行」でも「保存した配置を読み込む」でも、結果として座席表が埋まった
  // ときに畳みたいので、ボタンではなく座席表そのものを見る。
  // 一度だけ自動で畳み、そのあとは利用者の操作を尊重して勝手に動かさない。
  var autoCollapsed = false;
  new MutationObserver(function () {
    if (autoCollapsed) return;
    if (!byId('seat-grid').querySelector('.person-card')
      && !byId('night-seat-grid').querySelector('.person-card')) return;
    autoCollapsed = true;
    setupFold.set(false);
  }).observe(dayPanel, { childList: true, subtree: true });

  // ---------- ②メッセージ ----------
  var LEVELS = [
    { key: 'error', label: '中断' },
    { key: 'violation', label: '違反' },
    { key: 'warn', label: '注意' },
    { key: 'info', label: 'お知らせ' }
  ];
  var filterBar = document.createElement('div');
  filterBar.className = 'ux-msg-filter';
  var filterBtns = {};
  var allBtn = makeBtn('すべて', 'すべてのメッセージを表示します');
  allBtn.classList.add('is-active');
  allBtn.appendChild(document.createElement('b'));
  filterBar.appendChild(allBtn);
  filterBtns.all = allBtn;
  LEVELS.forEach(function (lv) {
    var b = makeBtn(lv.label, lv.label + 'のメッセージだけを表示します');
    b.appendChild(document.createElement('b'));
    filterBar.appendChild(b);
    filterBtns[lv.key] = b;
  });
  messages.parentNode.insertBefore(filterBar, messages);

  // ②メッセージ欄も畳める。開閉の状態は次回も引き継ぐ（毎回畳み直さなくて済むように）。
  // ただし赤（中断）・オレンジ（違反）が出たときは、下の refreshMessageCounts で必ず開く。
  var msgFold = makeCollapsible(msgPanel);
  var headFlags = makeFlags();
  msgPanel.querySelector('h2 .ux-fold').before(headFlags);
  var msgFoldSet = msgFold.set;
  msgFold.set = function (open) {
    msgFoldSet(open);
    prefs.msgOpen = open;
    savePrefs();
  };
  msgFold.set(prefs.msgOpen !== false);

  var activeFilter = 'all';
  function applyFilter(key) {
    activeFilter = key;
    LEVELS.forEach(function (lv) { messages.classList.remove('ux-only-' + lv.key); });
    if (key !== 'all') messages.classList.add('ux-only-' + key);
    Object.keys(filterBtns).forEach(function (k) {
      filterBtns[k].classList.toggle('is-active', k === key);
    });
  }
  Object.keys(filterBtns).forEach(function (k) {
    filterBtns[k].addEventListener('click', function () { applyFilter(k); });
  });

  function refreshMessageCounts() {
    var total = 0;
    var serious = 0;
    barFlags.textContent = '';
    headFlags.textContent = '';
    LEVELS.forEach(function (lv) {
      var n = messages.querySelectorAll('.log-line.' + lv.key).length;
      total += n;
      if (lv.key === 'error' || lv.key === 'violation') serious += n;
      var b = filterBtns[lv.key];
      b.querySelector('b').textContent = n ? ' ' + n : '';
      b.disabled = n === 0;
      // 目印は件数のあるものだけ出す（0が4つ並ぶと、かえって読み取りにくい）
      if (n > 0) {
        [barFlags, headFlags].forEach(function (holder) {
          var f = document.createElement('i');
          f.className = 'ux-flag ' + lv.key;
          f.textContent = String(n);
          f.title = lv.label + ' ' + n + '件';
          holder.appendChild(f);
        });
      }
    });
    allBtn.querySelector('b').textContent = total ? ' ' + total : '';
    // 選んでいた種別が0件になったら、黙って空欄にならないよう「すべて」に戻す
    if (activeFilter !== 'all' && filterBtns[activeFilter].disabled) applyFilter('all');
    // 赤（中断）・オレンジ（違反）が出たときは、畳んであっても必ず開く。
    // 見落とすと、できていない座席表を印刷してしまうため。
    if (serious > 0 && !msgFold.isOpen()) msgFold.set(true);
    syncBarHeight();
  }
  new MutationObserver(refreshMessageCounts).observe(messages, { childList: true, subtree: true });
  refreshMessageCounts();

  navMsg.addEventListener('click', function () {
    msgFold.set(true);
    msgPanel.scrollIntoView({ behavior: 'smooth', block: 'start' });
  });

  // ---------- 日勤／夜勤の切り替え ----------
  var VIEWS = ['day', 'night', 'both'];
  var view = VIEWS.indexOf(prefs.view) >= 0 ? prefs.view : 'day';
  function setView(next, scroll) {
    view = next;
    VIEWS.forEach(function (v) { document.body.classList.toggle('ux-view-' + v, v === next); });
    tabDay.classList.toggle('is-active', next === 'day');
    tabNight.classList.toggle('is-active', next === 'night');
    tabBoth.classList.toggle('is-active', next === 'both');
    prefs.view = next;
    savePrefs();
    if (scroll) (next === 'night' ? nightPanel : dayPanel).scrollIntoView({ behavior: 'smooth', block: 'start' });
  }
  tabDay.addEventListener('click', function () { setView('day', true); });
  tabNight.addEventListener('click', function () { setView('night', true); });
  tabBoth.addEventListener('click', function () { setView('both', true); });
  setView(view, false);

  // 日勤⇔夜勤のドラッグ移動を殺さないための逃がし。
  // 片方だけ表示しているときにカードをつかんだら、その場で「両方」表示に切り替える。
  // 表示を増やすだけなので、つかんでいるカードは消えず、ドラッグはそのまま続けられる。
  document.addEventListener('dragstart', function () {
    if (view !== 'both') setView('both', false);
  }, true);

  // ---------- ヘルプトグルの横並び ----------
  // 連続して並んでいる <details class="help"> を1つの箱にまとめる。
  // 閉じているあいだは横に並び、開いたものだけが1行を占める（見た目はCSS側）。
  // ①のヘルプは折りたたみ箱の中へ移っているので、そちらも対象にする。
  Array.prototype.forEach.call(document.querySelectorAll('.panel, .ux-collapsible'), function (host) {
    var groups = [];
    var current = null;
    Array.prototype.forEach.call(Array.prototype.slice.call(host.children), function (child) {
      if (child.tagName === 'DETAILS' && child.classList.contains('help')) {
        if (!current) { current = { anchor: child, items: [] }; groups.push(current); }
        current.items.push(child);
      } else {
        current = null;
      }
    });
    groups.forEach(function (g) {
      var box = document.createElement('div');
      box.className = 'ux-help-group';
      g.anchor.parentNode.insertBefore(box, g.anchor);
      g.items.forEach(function (d) { box.appendChild(d); });
    });
  });
  // 開閉のたびに高さが変わるので、バーの高さを測り直す
  Array.prototype.forEach.call(document.querySelectorAll('details.help'), function (d) {
    d.addEventListener('toggle', syncBarHeight);
  });

  // ---------- コンパクト表示 ----------
  function setCompact(on) {
    document.body.classList.toggle('ux-compact', on);
    densityBtn.classList.toggle('is-active', on);
    densityBtn.textContent = on ? '標準' : 'コンパクト';
    densityBtn.title = on ? '余白を元に戻します' : '余白を詰めて、1画面に入る情報を増やします';
    densityBtn.setAttribute('aria-pressed', String(on));
    prefs.compact = on;
    savePrefs();
    syncBarHeight();
  }
  densityBtn.addEventListener('click', function () {
    setCompact(!document.body.classList.contains('ux-compact'));
  });
  setCompact(prefs.compact === true);

  // ---------- キーボード ----------
  // Alt+2〜4 と Alt+0。日本語入力の変換中は何もしない。
  document.addEventListener('keydown', function (e) {
    if (!e.altKey || e.ctrlKey || e.metaKey || e.isComposing) return;
    var map = { '2': navMsg, '3': tabDay, '4': tabNight, '0': tabBoth };
    var target = map[e.key];
    if (!target) return;
    e.preventDefault();
    target.click();
  });

  syncBarHeight();
  window.addEventListener('load', syncBarHeight);
}());

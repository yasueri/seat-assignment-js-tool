// ============================================================
// ui.js
// 画面の描画、ドラッグ&ドロップ、ファイル入力、印刷ページ出力を担当する。
// csv.js と algorithm.js が先に読み込まれている前提。
// ============================================================
(function (NS) {
  "use strict";

  const {
    parseShiftMonthlyRows, rowsForDate, yearMonthLabelFromDates,
    parseRookieRows, parseSecretRows, timeToMinutes,
  } = NS.csv;
  const {
    SEATS, seatExists, ADJACENCY, assignSeats, assignLeaderAreas,
    buildSecretIndexes, buildAdjacentGroups, overlaps, isForbiddenPair,
    seatByNumber, numberOfKey, numberOfSeat,
  } = NS.algorithm;

  const WEEKDAY_NAMES = ['日', '月', '火', '水', '木', '金', '土'];
  const LEADER_ROWS = [1, 2, 3], LEADER_COLS = [1, 2, 3];

  // ---------- 表示用ヘルパー ----------
  // 座席番号の配列を、1〜2件なら番号を、3件以上なら「複数有」を返す（バッジ表示用）
  function seatNumbersLabel(numbers, sep) {
    if (!numbers || numbers.length === 0) return '';
    if (numbers.length <= 2) return numbers.slice().sort((a, b) => a - b).join(sep);
    return '複数有';
  }

  // 氏名の表示用省略。5文字以下ならそのまま、6文字以上なら先頭4文字+「...」にする
  // （空白も1文字として数える）。例: 「田中太郎」(4文字)→そのまま／
  // 6文字の氏名→先頭4文字+「...」
  function truncateName(name) {
    const chars = Array.from(name);
    if (chars.length <= 5) return name;
    return chars.slice(0, 4).join('') + '...';
  }

  // ---------- アプリの状態 ----------
  const rawText = { shift: null, rookie: null, secret: null };
  const appState = {
    seats: initEmptyState(), early: initLeaderState(), late: initLeaderState(),
    overflow: [], ruleIndexes: null, adjacentGroupLetters: null, currentDateLabel: null,
  };
  let dragSource = null;
  let hasRunOnce = false;
  let editingLoc = null; // 現在手入力編集中のカードの位置（null なら誰も編集していない）
  let shiftMonthly = null; // 月間シフトCSVのパース結果 { rows, logs, dates }

  // 何度も参照するDOM要素はここでまとめて取得しておく
  const els = {
    messages: document.getElementById('messages'),
    seatGrid: document.getElementById('seat-grid'),
    overflowList: document.getElementById('overflow-list'),
    overflowAppend: document.getElementById('overflow-append'),
    dateSelect: document.getElementById('date-select'),
    yearMonthLabel: document.getElementById('year-month-label'),
    earlyGrid: document.getElementById('early-grid'),
    lateGrid: document.getElementById('late-grid'),
  };
  // overflow-append は再描画のたびに作り直される要素ではないため、
  // ドロップ受付は最初に1回だけ登録する（毎回登録するとリスナーが積み重なってしまう）
  makeDropTarget(els.overflowAppend, { type: 'overflow-append' });

  function initEmptyState() {
    const seats = {};
    for (const s of SEATS) seats[s.key] = [null, null];
    return seats;
  }

  // 早番・遅番エリア用（3行×3列、1枠1名）
  function initLeaderState() {
    const s = {};
    LEADER_ROWS.forEach(r => LEADER_COLS.forEach(c => { s[`${r}-${c}`] = null; }));
    return s;
  }

  // ---------- ファイル読み込み ----------
  const fileStatusEls = {
    shift: document.getElementById('status-shift'),
    rookie: document.getElementById('status-rookie'),
    secret: document.getElementById('status-secret'),
  };

  function markFileLoaded(key, filename) {
    const el = fileStatusEls[key];
    el.textContent = `読み込み済み: ${filename}`;
    el.classList.remove('empty');
  }
  function markFileFailed(key) {
    const el = fileStatusEls[key];
    el.textContent = '読み込みに失敗しました';
    el.classList.add('empty');
  }

  async function loadFileInto(key, file) {
    try {
      rawText[key] = await file.text();
      markFileLoaded(key, file.name);
      if (key === 'shift') refreshShiftMonthly();
    } catch (e) {
      markFileFailed(key);
      if (key === 'shift') { shiftMonthly = null; populateDateSelect(null); }
    }
  }

  // 月間シフトCSVを読み込み直すたびに呼び、日付セレクタを更新する
  function refreshShiftMonthly() {
    shiftMonthly = parseShiftMonthlyRows(rawText.shift);
    populateDateSelect(shiftMonthly);
  }

  // 「配置対象日」セレクタを、読み込んだ月間シフトCSVの日付一覧で埋める
  function populateDateSelect(monthly) {
    const select = els.dateSelect;
    const ymLabel = els.yearMonthLabel;
    const dates = (monthly && monthly.dates) || [];
    select.innerHTML = '';
    if (dates.length === 0) {
      select.disabled = true;
      const opt = document.createElement('option');
      opt.value = '';
      opt.textContent = '（月間シフトCSV読み込み後に選択できます）';
      select.appendChild(opt);
      ymLabel.textContent = '';
      return;
    }
    dates.forEach(d => {
      const opt = document.createElement('option');
      opt.value = d;
      const dt = new Date(d + 'T00:00:00');
      opt.textContent = `${dt.getDate()}日（${WEEKDAY_NAMES[dt.getDay()]}）`;
      select.appendChild(opt);
    });
    select.disabled = false;
    ymLabel.textContent = yearMonthLabelFromDates(dates);
  }

  function formatDateLabel(dateStr) {
    const dt = new Date(dateStr + 'T00:00:00');
    return `${dt.getFullYear()}年${dt.getMonth() + 1}月${dt.getDate()}日（${WEEKDAY_NAMES[dt.getDay()]}）`;
  }

  function setupFileInput(inputId, key) {
    const input = document.getElementById(inputId);
    input.addEventListener('change', async () => {
      const file = input.files[0];
      if (!file) return;
      await loadFileInto(key, file);
      input.value = ''; // 同じファイルを選び直しても change が発火するようにする
    });
  }
  setupFileInput('file-shift', 'shift');
  setupFileInput('file-rookie', 'rookie');
  setupFileInput('file-secret', 'secret');

  // ---------- CSVファイルのまとめてドラッグ&ドロップ ----------
  // ファイル名に含まれる文字列から、shift/rookie/secretのどれに該当するかを判定する
  function classifyFileName(filename) {
    const lower = filename.toLowerCase();
    if (lower.includes('shift')) return 'shift';
    if (lower.includes('rookie')) return 'rookie';
    if (lower.includes('secret')) return 'secret';
    return null;
  }

  const dropzone = document.getElementById('csv-dropzone');
  dropzone.addEventListener('dragover', (e) => { e.preventDefault(); dropzone.classList.add('dragover'); });
  dropzone.addEventListener('dragleave', () => dropzone.classList.remove('dragover'));
  dropzone.addEventListener('drop', async (e) => {
    e.preventDefault();
    dropzone.classList.remove('dragover');
    const files = Array.from((e.dataTransfer && e.dataTransfer.files) || []);
    if (files.length === 0) return;

    const unmatched = [];
    for (const file of files) {
      const key = classifyFileName(file.name);
      if (!key) { unmatched.push(file.name); continue; }
      await loadFileInto(key, file);
    }
    if (unmatched.length > 0) {
      alert(`ファイル名から種類を判別できませんでした: ${unmatched.join(', ')}\nファイル名に shift / rookie / secret のいずれかを含めてください。`);
    }
  });

  // ページの他の場所にファイルがドロップされた際、ブラウザがファイルを開いて
  // 遷移してしまわないようにする（誤ってドロップ位置がずれた場合の保険）
  document.addEventListener('dragover', (e) => e.preventDefault());
  document.addEventListener('drop', (e) => e.preventDefault());

  // ---------- メッセージ表示 ----------
  function renderMessages(logs) {
    const box = els.messages;
    box.innerHTML = '';
    if (!logs || logs.length === 0) {
      box.innerHTML = '<div class="empty-note">問題は見つかりませんでした。</div>';
      return;
    }
    logs.forEach(l => {
      const div = document.createElement('div');
      div.className = `log-line ${l.level}`;
      div.textContent = l.message;
      box.appendChild(div);
    });
  }

  // メッセージ欄までスクロールして、一瞬枠を光らせる（ボタンとメッセージ欄が離れていて見落とされるのを防ぐ）
  function scrollToMessages() {
    const panel = document.getElementById('messages-panel');
    if (!panel) return;
    panel.scrollIntoView({ behavior: 'smooth', block: 'start' });
    panel.classList.remove('flash-highlight');
    void panel.offsetWidth; // アニメーションを再トリガーするための強制リフロー
    panel.classList.add('flash-highlight');
  }

  // 抽出した1日分の行を、座席グリッド用（OPかつ夜勤でない）と
  // 早番・遅番エリア用（役席・GL、夜勤かどうかは問わない）に振り分ける。
  // 役割=OPかつ夜勤のスタッフは、今回のバージョンでは配置対象外（ver3.0で対応予定）。
  function splitDayRows(dayRows) {
    const opRows = [];
    const leaderRows = [];
    dayRows.forEach(r => {
      if (r.role === 'OP') {
        if (!r.nightShift) {
          opRows.push({ name: r.name, start: r.start, end: r.end, startMin: r.startMin, endMin: r.endMin, frontOT: r.frontOT, backOT: r.backOT });
        }
        // 夜勤OPは今回は対象外（ver3.0で対応予定）
      } else {
        leaderRows.push({
          name: r.name, start: r.start, end: r.end, startMin: r.startMin, endMin: r.endMin,
          frontOT: r.frontOT, backOT: r.backOT, role: r.role, isLate: r.lateShift,
        });
      }
    });
    return { opRows, leaderRows };
  }

  // ---------- 自動配置の実行 ----------
  document.getElementById('btn-run').addEventListener('click', () => {
    if (!rawText.shift || !rawText.rookie || !rawText.secret) {
      alert('月間シフトCSV / rookie.csv / secret.csv をすべて選択してください。');
      return;
    }
    if (!shiftMonthly || shiftMonthly.dates.length === 0) {
      alert('月間シフトCSVを正しく読み込めませんでした。ファイルの形式をご確認ください。');
      return;
    }
    const selectedDate = els.dateSelect.value;
    if (!selectedDate) {
      alert('配置対象日を選択してください。');
      return;
    }

    const rookieParsed = parseRookieRows(rawText.rookie);
    const secretParsed = parseSecretRows(rawText.secret, seatByNumber);
    const dayRows = rowsForDate(shiftMonthly.rows, selectedDate);
    const { opRows, leaderRows } = splitDayRows(dayRows);

    const allLogs = [...shiftMonthly.logs, ...rookieParsed.logs, ...secretParsed.logs];

    // 席固定・禁止席で同じ人が複数行に分かれている場合は、配置を実行せずに知らせる
    // （複数の座席は1行にまとめてスペース区切りで指定する仕様のため）
    const secretDuplicateMessage = (kind, name) =>
      `secret.csv: 「${name}」さんが「${kind}」に複数行あります。1人1行にまとめ、複数の座席は半角または全角スペース区切りで指定してください。`;
    const dupMessages = [
      ...(secretParsed.duplicateDesignatedNames || []).map(name => ({ level: 'error', message: secretDuplicateMessage('席固定', name) })),
      ...(secretParsed.duplicateForbiddenNames || []).map(name => ({ level: 'error', message: secretDuplicateMessage('禁止席', name) })),
    ];
    if (dupMessages.length > 0) {
      renderMessages([...allLogs, ...dupMessages]);
      scrollToMessages();
      return; // secret.csv を修正してもらうため、配置は実行しない
    }

    if (hasRunOnce) {
      const ok = confirm('手動で調整した内容は失われます。自動配置をやり直しますか？');
      if (!ok) return;
    }

    const seatResult = assignSeats(opRows, rookieParsed.rows, secretParsed.rows);
    const leaderResult = assignLeaderAreas(leaderRows);
    allLogs.push(...seatResult.logs, ...leaderResult.logs);

    appState.seats = seatResult.state;
    appState.early = leaderResult.early;
    appState.late = leaderResult.late;
    appState.overflow = [...seatResult.overflow, ...leaderResult.overflow];
    appState.ruleIndexes = buildSecretIndexes(secretParsed.rows);
    appState.adjacentGroupLetters = buildAdjacentGroups(secretParsed.rows);
    appState.currentDateLabel = formatDateLabel(selectedDate);
    hasRunOnce = true;
    editingLoc = null;

    renderMessages(allLogs);
    render();
    scrollToMessages();

    // 個別ダイアログが必要なログのみ alert 表示
    allLogs.filter(l => l.showDialog).forEach(l => alert(l.message));
  });

  // ---------- 描画（座席グリッド・あふれ） ----------

  // 位置（座席のスロット・早番/遅番エリアの枠・あふれの何番目か）が同じかどうか
  function locEquals(a, b) {
    if (!a || !b || a.type !== b.type) return false;
    if (a.type === 'seat') return a.seatKey === b.seatKey && a.slotIndex === b.slotIndex;
    if (a.type === 'early' || a.type === 'late') return a.key === b.key;
    if (a.type === 'overflow') return a.index === b.index;
    return false;
  }

  // 氏名を手入力で変更したとき、secret.csvのルール（席固定・禁止席・隣接禁止）を
  // 新しい氏名で判定し直してバッジ用の情報を作る（新人バッジは対象外。自動配置時の
  // 優先度に基づくもので、手入力の変更で再判定する性質のものではないため）。
  function deriveBadgeFields(name) {
    const idx = appState.ruleIndexes;
    if (!idx) {
      return { hasAdjacentRule: false, hasForbiddenSeatRule: false, isDesignated: false, designatedSeatNumbers: [], forbiddenSeatNumbers: [], adjacentGroupLetter: null };
    }
    const letters = appState.adjacentGroupLetters;
    return {
      hasAdjacentRule: idx.adjacentRuleNames.has(name),
      hasForbiddenSeatRule: idx.forbiddenSeatRuleNames.has(name),
      isDesignated: idx.designatedNames.has(name),
      designatedSeatNumbers: (idx.designatedSeatsMap.get(name) || []).map(numberOfKey),
      forbiddenSeatNumbers: (idx.forbiddenSeatsMap.get(name) || []).map(numberOfKey),
      adjacentGroupLetter: (letters && letters.get(name)) || null,
    };
  }

  // 指定した位置以外に、同じ氏名の人がすでにいないか確認する（手入力での重複防止）
  function isNameUsedElsewhere(name, loc) {
    for (const s of SEATS) {
      for (let i = 0; i < 2; i++) {
        if (loc.type === 'seat' && loc.seatKey === s.key && loc.slotIndex === i) continue;
        const p = appState.seats[s.key][i];
        if (p && p.name === name) return true;
      }
    }
    for (const [areaType, areaState] of [['early', appState.early], ['late', appState.late]]) {
      for (const key of Object.keys(areaState)) {
        if (loc.type === areaType && loc.key === key) continue;
        const p = areaState[key];
        if (p && p.name === name) return true;
      }
    }
    for (let i = 0; i < appState.overflow.length; i++) {
      if (loc.type === 'overflow' && loc.index === i) continue;
      const p = appState.overflow[i];
      if (p && p.name === name) return true;
    }
    return false;
  }

  // その日の配置から完全に削除する（あふれにも残らない）
  function deletePersonAt(loc) {
    setPersonAt(loc, null);
    appState.overflow = appState.overflow.filter(Boolean);
  }

  // 1〜2行のバッジを1つ作る（line2が空なら1行のみ）
  function makeBadge(cls, line1, line2) {
    const b = document.createElement('span');
    b.className = 'badge ' + cls;
    const l1 = document.createElement('div');
    l1.className = 'badge-line1';
    l1.textContent = line1;
    b.appendChild(l1);
    if (line2) {
      const l2 = document.createElement('div');
      l2.className = 'badge-line2';
      l2.textContent = line2;
      b.appendChild(l2);
    }
    return b;
  }

  // ✎編集ボタン（座席カード・早番/遅番カードで共通）
  function createEditToggleButton(loc) {
    const editToggle = document.createElement('button');
    editToggle.type = 'button';
    editToggle.className = 'edit-toggle';
    editToggle.textContent = '✎';
    editToggle.setAttribute('aria-label', '氏名・時間を編集');
    editToggle.title = '氏名・時間を編集';
    // 編集ボタンからドラッグが始まって、カードごと動いてしまわないようにする
    editToggle.addEventListener('dragstart', (e) => { e.preventDefault(); e.stopPropagation(); });
    editToggle.addEventListener('click', (e) => {
      e.stopPropagation();
      editingLoc = loc;
      render();
      const nameField = document.querySelector('.edit-form .edit-name');
      if (nameField) { nameField.focus(); nameField.select(); }
    });
    return editToggle;
  }

  // 時刻1つ分の表示。残業（前残業/後残業）の場合は黄色ハイライト+「※」マークを付ける
  function makeTimeSpan(text, isOT) {
    const span = document.createElement('span');
    span.textContent = text;
    if (isOT) {
      span.classList.add('ot-time');
      span.title = '残業';
      const mark = document.createElement('sup');
      mark.className = 'ot-mark';
      mark.textContent = '※';
      span.appendChild(mark);
    }
    return span;
  }

  function createPersonCard(loc, person) {
    const card = document.createElement('div');
    card.className = 'person-card' + (person.isRookie ? ' rookie' : '');
    card.draggable = true;

    const info = document.createElement('div');
    info.className = 'info';

    const nameRow = document.createElement('div');
    nameRow.className = 'name-row';

    const nameLine = document.createElement('div');
    nameLine.className = 'name';
    nameLine.textContent = truncateName(person.name);
    nameLine.title = person.name; // 省略されている場合でも、全体をツールチップで確認できるようにする
    nameRow.appendChild(nameLine);
    nameRow.appendChild(createEditToggleButton(loc));

    info.appendChild(nameRow);

    const timeLine = document.createElement('div');
    timeLine.className = 'time';
    timeLine.appendChild(makeTimeSpan(person.start, person.frontOT));
    const sepSpan = document.createElement('span');
    sepSpan.className = 'time-sep';
    sepSpan.textContent = '-';
    timeLine.appendChild(sepSpan);
    timeLine.appendChild(makeTimeSpan(person.end, person.backOT));
    info.appendChild(timeLine);

    card.appendChild(info);

    const badges = document.createElement('div');
    badges.className = 'badges';
    if (person.isRookie) {
      badges.appendChild(makeBadge('rookie', person.rookieRank ? `新人${person.rookieRank}` : '新人'));
    }
    if (person.isDesignated) {
      const label = seatNumbersLabel(person.designatedSeatNumbers, '・');
      badges.appendChild(makeBadge('designated', '席固定', label));
    }
    if (person.hasForbiddenSeatRule) {
      const label = seatNumbersLabel(person.forbiddenSeatNumbers, ',');
      badges.appendChild(makeBadge('lock', '禁止席', label));
    }
    if (person.hasAdjacentRule) {
      badges.appendChild(makeBadge('lock', '隣禁止', person.adjacentGroupLetter || ''));
    }
    card.appendChild(badges);

    card.addEventListener('dragstart', (e) => {
      dragSource = loc;
      e.dataTransfer.effectAllowed = 'move';
    });
    return card;
  }

  // 早番・遅番エリア用のカード（役席・GL）。座席カードより幅が狭いため縦積みレイアウトにする。
  function createLeaderCard(loc, person) {
    const card = document.createElement('div');
    card.className = 'leader-card';
    card.draggable = true;

    const nameRow = document.createElement('div');
    nameRow.className = 'leader-name-row';
    const nameLine = document.createElement('span');
    nameLine.className = 'leader-name';
    nameLine.textContent = truncateName(person.name);
    nameLine.title = person.name;
    nameRow.appendChild(nameLine);
    nameRow.appendChild(createEditToggleButton(loc));
    card.appendChild(nameRow);

    const roleBadge = document.createElement('span');
    roleBadge.className = 'leader-role-badge ' + (person.role === '役席' ? 'yakuseki' : 'gl');
    roleBadge.textContent = person.role || '';
    card.appendChild(roleBadge);

    const timeLine = document.createElement('div');
    timeLine.className = 'leader-time';
    timeLine.appendChild(makeTimeSpan(person.start, person.frontOT));
    const sepSpan = document.createElement('span');
    sepSpan.className = 'time-sep';
    sepSpan.textContent = '-';
    timeLine.appendChild(sepSpan);
    timeLine.appendChild(makeTimeSpan(person.end, person.backOT));
    card.appendChild(timeLine);

    card.addEventListener('dragstart', (e) => {
      dragSource = loc;
      e.dataTransfer.effectAllowed = 'move';
    });
    return card;
  }

  // 氏名・時間の手入力編集フォーム（1件分）。保存/キャンセル/削除の操作を持つ。
  function createEditForm(loc, person) {
    const form = document.createElement('div');
    form.className = 'edit-form';

    const nameInput = document.createElement('input');
    nameInput.type = 'text';
    nameInput.className = 'edit-input edit-name';
    nameInput.value = person.name;
    nameInput.setAttribute('aria-label', '氏名');
    form.appendChild(nameInput);

    const timeRow = document.createElement('div');
    timeRow.className = 'edit-time-row';
    const startInput = document.createElement('input');
    startInput.type = 'text';
    startInput.className = 'edit-input edit-time';
    startInput.value = person.start;
    startInput.placeholder = '9:00';
    startInput.setAttribute('aria-label', '出勤時刻');
    const sep = document.createElement('span');
    sep.className = 'edit-time-sep';
    sep.textContent = '-';
    const endInput = document.createElement('input');
    endInput.type = 'text';
    endInput.className = 'edit-input edit-time';
    endInput.value = person.end;
    endInput.placeholder = '18:00';
    endInput.setAttribute('aria-label', '退勤時刻');
    timeRow.appendChild(startInput);
    timeRow.appendChild(sep);
    timeRow.appendChild(endInput);
    form.appendChild(timeRow);

    const errorDiv = document.createElement('div');
    errorDiv.className = 'edit-error';
    form.appendChild(errorDiv);

    const btnRow = document.createElement('div');
    btnRow.className = 'edit-btn-row';
    const saveBtn = document.createElement('button');
    saveBtn.type = 'button';
    saveBtn.className = 'edit-btn save';
    saveBtn.textContent = '保存';
    const cancelBtn = document.createElement('button');
    cancelBtn.type = 'button';
    cancelBtn.className = 'edit-btn cancel';
    cancelBtn.textContent = 'キャンセル';
    const deleteBtn = document.createElement('button');
    deleteBtn.type = 'button';
    deleteBtn.className = 'edit-btn delete';
    deleteBtn.textContent = '削除';
    btnRow.appendChild(saveBtn);
    btnRow.appendChild(cancelBtn);
    btnRow.appendChild(deleteBtn);
    form.appendChild(btnRow);

    function save() {
      const newName = nameInput.value.trim();
      const newStart = startInput.value.trim();
      const newEnd = endInput.value.trim();

      if (!newName) { errorDiv.textContent = '氏名を入力してください。'; return; }
      if (isNameUsedElsewhere(newName, loc)) {
        errorDiv.textContent = `「${newName}」は既に他の座席・あふれで使われています。`;
        return;
      }
      const startMin = timeToMinutes(newStart);
      const endMin = timeToMinutes(newEnd);
      if (startMin == null || endMin == null) {
        errorDiv.textContent = '時刻は 9:00 のような形式で入力してください。';
        return;
      }
      if (startMin >= endMin) {
        errorDiv.textContent = '開始時刻は終了時刻より前にしてください。';
        return;
      }

      const updated = {
        ...person,
        name: newName, start: newStart, end: newEnd, startMin, endMin,
        ...deriveBadgeFields(newName),
      };
      setPersonAt(loc, updated);
      editingLoc = null;
      render();
    }

    saveBtn.addEventListener('click', save);
    cancelBtn.addEventListener('click', () => { editingLoc = null; render(); });
    deleteBtn.addEventListener('click', () => {
      const ok = confirm(`${person.name}さんをこの日の配置から完全に削除します（あふれにも残りません）。よろしいですか？`);
      if (!ok) return;
      deletePersonAt(loc);
      editingLoc = null;
      render();
    });

    [nameInput, startInput, endInput].forEach(input => {
      input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') { e.preventDefault(); save(); }
        else if (e.key === 'Escape') { e.preventDefault(); cancelBtn.click(); }
      });
    });

    return form;
  }

  function getPersonAt(loc) {
    if (loc.type === 'seat') return appState.seats[loc.seatKey][loc.slotIndex];
    if (loc.type === 'early') return appState.early[loc.key];
    if (loc.type === 'late') return appState.late[loc.key];
    if (loc.type === 'overflow') return appState.overflow[loc.index];
    return null;
  }
  function setPersonAt(loc, person) {
    if (loc.type === 'seat') appState.seats[loc.seatKey][loc.slotIndex] = person;
    else if (loc.type === 'early') appState.early[loc.key] = person;
    else if (loc.type === 'late') appState.late[loc.key] = person;
    else if (loc.type === 'overflow') appState.overflow[loc.index] = person;
  }

  // ドラッグ元とドロップ先の中身を入れ替える（人単位の移動・交換）
  function handleDrop(target) {
    if (!dragSource) return;
    editingLoc = null; // ドラッグ操作が起きたら、開いていた編集フォームは閉じる
    if (target.type === 'overflow-append') {
      const person = getPersonAt(dragSource);
      if (!person) return;
      setPersonAt(dragSource, null);
      appState.overflow.push(person);
    } else {
      const personA = getPersonAt(dragSource);
      const personB = getPersonAt(target);
      setPersonAt(dragSource, personB);
      setPersonAt(target, personA);
    }
    appState.overflow = appState.overflow.filter(Boolean); // 入れ替えで生じた穴を詰める
    dragSource = null;
    render();
  }

  // 座席のスロット1つ分（空席 or 人物カード or 編集フォーム）とドロップ受付を作る
  function makeDropTarget(el, loc) {
    el.addEventListener('dragover', (e) => { e.preventDefault(); el.classList.add('dragover'); });
    el.addEventListener('dragleave', () => el.classList.remove('dragover'));
    el.addEventListener('drop', (e) => { e.preventDefault(); el.classList.remove('dragover'); handleDrop(loc); });
  }

  function createSlot(loc) {
    const slot = document.createElement('div');
    slot.className = 'slot';
    const person = getPersonAt(loc);
    if (person) {
      slot.classList.add('filled');
      slot.appendChild(locEquals(loc, editingLoc) ? createEditForm(loc, person) : createPersonCard(loc, person));
    } else {
      slot.textContent = '空席';
    }
    makeDropTarget(slot, loc);
    return slot;
  }

  function renderSeatGrid() {
    const grid = els.seatGrid;
    grid.innerHTML = '';
    for (let row = 1; row <= 4; row++) {
      for (let col = 1; col <= 4; col++) {
        if (!seatExists(row, col)) {
          const spacer = document.createElement('div');
          spacer.className = 'seat spacer';
          grid.appendChild(spacer);
          continue;
        }
        const key = `${row}-${col}`;
        const seatDiv = document.createElement('div');
        seatDiv.className = 'seat';

        const coord = document.createElement('div');
        coord.className = 'seat-coord';
        coord.textContent = numberOfSeat(row, col);
        seatDiv.appendChild(coord);

        seatDiv.appendChild(createSlot({ type: 'seat', seatKey: key, slotIndex: 0 }));
        seatDiv.appendChild(createSlot({ type: 'seat', seatKey: key, slotIndex: 1 }));

        grid.appendChild(seatDiv);
      }
    }
  }

  // 早番・遅番エリア（3行×3列、1枠1名）を描画する
  function renderLeaderGrid(containerEl, areaType, numberPrefix) {
    if (!containerEl) return;
    containerEl.innerHTML = '';
    const stateObj = appState[areaType];
    let n = 0;
    LEADER_ROWS.forEach(row => {
      LEADER_COLS.forEach(col => {
        n++;
        const key = `${row}-${col}`;
        const loc = { type: areaType, key };
        const cell = document.createElement('div');
        cell.className = 'leader-cell';

        const coord = document.createElement('div');
        coord.className = 'leader-coord';
        coord.textContent = `${numberPrefix}${n}`;
        cell.appendChild(coord);

        const slot = document.createElement('div');
        slot.className = 'leader-slot';
        const person = stateObj[key];
        if (person) {
          slot.classList.add('filled');
          slot.appendChild(locEquals(loc, editingLoc) ? createEditForm(loc, person) : createLeaderCard(loc, person));
        } else {
          slot.textContent = '空き';
        }
        makeDropTarget(slot, loc);
        cell.appendChild(slot);

        containerEl.appendChild(cell);
      });
    });
  }

  function renderOverflow() {
    const list = els.overflowList;
    list.innerHTML = '';
    if (appState.overflow.length === 0) {
      const note = document.createElement('div');
      note.className = 'overflow-empty-note';
      note.textContent = 'あふれはありません。';
      list.appendChild(note);
    } else {
      appState.overflow.forEach((person, i) => {
        const loc = { type: 'overflow', index: i };
        const wrapper = document.createElement('div');
        wrapper.className = 'overflow-slot';
        wrapper.appendChild(locEquals(loc, editingLoc) ? createEditForm(loc, person) : createPersonCard(loc, person));
        makeDropTarget(wrapper, loc);
        list.appendChild(wrapper);
      });
    }
  }

  function render() {
    renderLeaderGrid(els.earlyGrid, 'early', '早');
    renderLeaderGrid(els.lateGrid, 'late', '遅');
    renderSeatGrid();
    renderOverflow();
  }
  render();

  // ドラッグがドロップ対象の外で終了した場合でも、ハイライトが残らないようにする
  document.addEventListener('dragend', () => {
    document.querySelectorAll('.dragover').forEach(el => el.classList.remove('dragover'));
  });

  // ---------- 手動調整後のルールチェック ----------
  function checkPlacementViolations() {
    if (!appState.ruleIndexes) {
      alert('先に「自動配置を実行」してください。');
      return;
    }
    const { forbiddenPairSet, forbiddenSeatSet, designatedSeatsMap } = appState.ruleIndexes;
    const violations = [];
    const reportedAdjacentPairs = new Set();

    for (const s of SEATS) {
      const occHere = appState.seats[s.key].filter(Boolean);

      // ルール2: 禁止席
      occHere.forEach(p => {
        if (forbiddenSeatSet.has(`${p.name}|${s.key}`)) {
          violations.push(`${p.name}さんが禁止されている${numberOfKey(s.key)}番の座席に配置されています`);
        }
      });

      // 同席2名までのうち、勤務時間が重なっていないか
      if (occHere.length === 2 && overlaps(occHere[0], occHere[1])) {
        violations.push(`${numberOfKey(s.key)}番の座席で、勤務時間が重なる${occHere[0].name}さんと${occHere[1].name}さんが同席しています`);
      }

      // ルール1: 隣接禁止（同じペアを2回報告しないようにする）
      for (const adjKey of ADJACENCY[s.key]) {
        const occAdj = appState.seats[adjKey].filter(Boolean);
        occHere.forEach(a => occAdj.forEach(b => {
          if (isForbiddenPair(a.name, b.name, forbiddenPairSet)) {
            const pairId = [a.name, b.name].sort().join('|') + '@' + [s.key, adjKey].sort().join(',');
            if (!reportedAdjacentPairs.has(pairId)) {
              reportedAdjacentPairs.add(pairId);
              violations.push(`${a.name}さんと${b.name}さんが隣接する座席に配置されています`);
            }
          }
        }));
      }
    }

    // ルール3: 席固定が守られているか（その日出勤している対象者のみチェック）
    for (const [name, seatKeys] of designatedSeatsMap.entries()) {
      const seatedAt = SEATS.find(s => appState.seats[s.key].filter(Boolean).some(p => p.name === name));
      const isInOverflow = appState.overflow.some(p => p.name === name);
      if (!seatedAt && !isInOverflow) continue; // その日出勤していない

      if (!seatedAt || !seatKeys.includes(seatedAt.key)) {
        const seatList = seatKeys.map(k => `${numberOfKey(k)}番`).join(' または ');
        violations.push(`${name}さんが指定された座席（${seatList}）に配置されていません`);
      }
    }

    renderMessages(violations.length === 0
      ? [{ level: 'info', message: '違反は見つかりませんでした。' }]
      : violations.map(m => ({ level: 'error', message: m })));
    scrollToMessages();
  }
  document.getElementById('btn-check').addEventListener('click', checkPlacementViolations);

  // ---------- 印刷用ページ ----------
  function escapeHtml(s) {
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  // 残業（前残業/後残業）の時刻表示。黄色背景（対応していれば）＋点線下線＋「※」マークの二重の目印にする
  // （ブラウザの「背景のグラフィック」印刷設定がオフでも、下線とマークは必ず印刷される）
  function printTimeSpan(text, isOT) {
    if (!isOT) return `<span class="pt">${escapeHtml(text)}</span>`;
    return `<span class="pt ot">${escapeHtml(text)}<sup class="ot-mark">※</sup></span>`;
  }

  // 座席1枠内の「1人分」を描画する。人がいなければ空のまま（枠の大きさは常に揃える）
  function printOccupantHtml(p) {
    if (!p) return '<div class="print-occupant"></div>';
    return '<div class="print-occupant">'
      + `<div class="print-name">${escapeHtml(p.name)}</div>`
      + `<div class="print-time">${printTimeSpan(p.start, p.frontOT)}<span class="pt-sep">-</span>${printTimeSpan(p.end, p.backOT)}</div>`
      + '<div class="print-blank"></div>'
      + '</div>';
  }

  // 早番・遅番エリア（3行×3列）を1つ分描画する
  function printLeaderColumnHtml(stateObj, label, numberPrefix) {
    let n = 0;
    let cellsHtml = '';
    LEADER_ROWS.forEach(row => {
      LEADER_COLS.forEach(col => {
        n++;
        const p = stateObj[`${row}-${col}`];
        cellsHtml += `<div class="print-leader-cell"><div class="coord">${numberPrefix}${n}</div>`;
        if (p) {
          cellsHtml += `<div class="print-leader-name">${escapeHtml(p.name)}</div>`
            + `<div class="print-leader-role">${escapeHtml(p.role || '')}</div>`
            + `<div class="print-leader-time">${printTimeSpan(p.start, p.frontOT)}<span class="pt-sep">-</span>${printTimeSpan(p.end, p.backOT)}</div>`;
        }
        cellsHtml += '</div>';
      });
    });
    return `<div class="print-leader-col"><h3>${escapeHtml(label)}</h3><div class="print-leader-grid">${cellsHtml}</div></div>`;
  }

  function buildPrintHtml(dateLabel, generatedLabel) {
    const leaderHtml = '<div class="print-leader-section">'
      + printLeaderColumnHtml(appState.early, '早番', '早')
      + printLeaderColumnHtml(appState.late, '遅番', '遅')
      + '</div>';

    let gridHtml = '<div class="print-grid">';
    for (let row = 1; row <= 4; row++) {
      for (let col = 1; col <= 4; col++) {
        if (!seatExists(row, col)) { gridHtml += '<div class="print-seat print-spacer"></div>'; continue; }
        const slots = appState.seats[`${row}-${col}`]; // [人 or null, 人 or null]（常に2枠）
        gridHtml += `<div class="print-seat"><div class="coord">${numberOfSeat(row, col)}</div>`
          + printOccupantHtml(slots[0])
          + '<div class="print-divider"></div>'
          + printOccupantHtml(slots[1])
          + '</div>';
      }
    }
    gridHtml += '</div>';

    let overflowHtml = '';
    if (appState.overflow.length > 0) {
      overflowHtml = '<div class="print-overflow"><h2>あふれ</h2><ul>'
        + appState.overflow.map(p => `<li>${escapeHtml(p.name)}（${escapeHtml(p.start)} - ${escapeHtml(p.end)}）</li>`).join('')
        + '</ul></div>';
    }
    // ※ 一覧のレイアウト（1行3列）は <style> 側の .print-overflow ul で指定

    // 残業（※マーク）が1件でもあれば、意味を説明する凡例を表示する
    const hasAnyOT = SEATS.some(s => (appState.seats[s.key] || []).some(p => p && (p.frontOT || p.backOT)))
      || Object.values(appState.early).some(p => p && (p.frontOT || p.backOT))
      || Object.values(appState.late).some(p => p && (p.frontOT || p.backOT));
    const legendHtml = hasAnyOT ? '<div class="print-legend">※…残業（前残業＝出勤時刻／後残業＝退勤時刻）</div>' : '';

    return `<!DOCTYPE html>
<html lang="ja">
<head>
<meta charset="UTF-8">
<title>${escapeHtml(dateLabel)} 座席表</title>
<style>
  @page { size: A4 portrait; margin: 14mm; }
  * { box-sizing: border-box; }
  body { font-family: "Yu Gothic UI","Meiryo","Hiragino Kaku Gothic ProN",sans-serif; color:#222; margin:0; }
  .print-generated { text-align:right; font-size:11px; color:#999; margin-bottom:2mm; }
  .print-title { text-align:center; font-size:24px; font-weight:700; margin-bottom:5mm; }
  .print-legend { font-size:10.5px; color:#777; text-align:right; margin:-2mm 0 3mm; }
  .print-leader-section { display:flex; gap:5mm; width:182mm; margin-bottom:5mm; }
  .print-leader-col { width:88.5mm; }
  .print-leader-col h3 { font-size:12.5px; margin:0 0 1.5mm; color:#333; }
  .print-leader-grid { display:grid; grid-template-columns:repeat(3, 1fr); gap:2.5mm; }
  .print-leader-cell { position:relative; border:1px solid #555; border-radius:2mm; height:14mm; padding:2.5mm 1.5mm 1mm; display:flex; flex-direction:column; justify-content:center; align-items:center; text-align:center; overflow:hidden; }
  .print-leader-cell .coord { position:absolute; top:0.6mm; right:1mm; font-size:7.5px; color:#999; line-height:1; }
  .print-leader-name { font-size:10.5px; font-weight:700; line-height:1.15; max-width:100%; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
  .print-leader-role { font-size:8px; color:#666; margin-top:0.3mm; }
  .print-leader-time { font-size:9px; color:#555; margin-top:0.3mm; }
  .print-grid { display:grid; grid-template-columns:repeat(4, 41.75mm); width:182mm; gap:5mm; }
  .print-seat { position:relative; border:1px solid #333; border-radius:3mm; padding:5mm 3mm 3mm 3mm; height:48mm; display:flex; flex-direction:column; }
  .print-spacer { border:none; }
  .print-seat .coord { position:absolute; top:1mm; right:1.5mm; font-size:12px; font-weight:700; color:#888; line-height:1; }
  .print-occupant { flex:1 1 0; display:flex; flex-direction:column; min-height:0; padding-top:1mm; text-align:center; }
  .print-name { font-size:16px; font-weight:600; }
  .print-time { font-size:15px; color:#555; margin-top:0.5mm; }
  .print-time .pt.ot { font-weight:700; background:#FFF6CC; border-bottom:1.5px dotted #333; border-radius:0.5mm; padding:0 0.5mm; }
  .print-time .ot-mark, .print-leader-time .ot-mark { font-size:8px; vertical-align:top; margin-left:0.3mm; }
  .print-leader-time .pt.ot { font-weight:700; background:#FFF6CC; border-bottom:1.2px dotted #333; }
  .pt-sep { margin:0 0.5mm; color:#777; }
  .print-blank { flex:1; border-bottom:1px dotted #bbb; margin:1mm 3mm 1mm 3mm; }
  .print-divider { border-top:1px dashed #999; margin:0.5mm 0; flex:0 0 auto; }
  .print-overflow { margin-top:8mm; }
  .print-overflow h2 { font-size:16px; border-bottom:1px solid #333; padding-bottom:2mm; }
  .print-overflow ul { list-style:none; margin:0; padding:0; display:grid; grid-template-columns:repeat(3, 1fr); gap:1.5mm 6mm; }
  .print-overflow li { font-size:15px; margin:0; }
  .no-print { text-align:center; margin-bottom:8mm; }
  .no-print button { font-size:15px; padding:9px 18px; cursor:pointer; }
  @media print { .no-print { display:none; } }
</style>
</head>
<body>
  <div class="no-print"><button onclick="window.print()">この内容を印刷する</button></div>
  <div class="print-generated">出力: ${escapeHtml(generatedLabel)}</div>
  <div class="print-title">${escapeHtml(dateLabel)} 座席表</div>
  ${legendHtml}
  ${leaderHtml}
  ${gridHtml}
  ${overflowHtml}
</body>
</html>`;
  }

  document.getElementById('btn-print').addEventListener('click', () => {
    const today = new Date();
    const pad = n => String(n).padStart(2, '0');
    const todayLabel = `${today.getFullYear()}年${pad(today.getMonth() + 1)}月${pad(today.getDate())}日`;
    const defaultLabel = appState.currentDateLabel || todayLabel;
    const dateLabel = prompt('座席表の日付を入力してください（前日に準備する場合などはご自由に変更してください）', defaultLabel);
    if (dateLabel === null) return; // キャンセル

    const generatedLabel = `${today.getFullYear()}/${pad(today.getMonth() + 1)}/${pad(today.getDate())} ${pad(today.getHours())}:${pad(today.getMinutes())}`;

    const win = window.open('', '_blank');
    if (!win) {
      alert('印刷用ページを開けませんでした。ブラウザのポップアップブロック設定をご確認ください。');
      return;
    }
    win.document.open();
    win.document.write(buildPrintHtml(dateLabel || defaultLabel, generatedLabel));
    win.document.close();
  });

})(window.SeatTool);

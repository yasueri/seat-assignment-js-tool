// ============================================================
// ui.js
// 画面の描画、ドラッグ&ドロップ、ファイル入力、CSV出力を担当する。
// csv.js と algorithm.js が先に読み込まれている前提。
// ============================================================
(function (NS) {
  "use strict";

  const { parseShiftRows, parseNewbeeRows, parseSecretRows, toCSV } = NS.csv;
  const { SEATS, seatExists, assignSeats } = NS.algorithm;

  // ---------- アプリの状態 ----------
  const rawText = { shift: null, newbee: null, secret: null };
  const appState = { seats: initEmptyState(), overflow: [] };
  let dragSource = null;
  let hasRunOnce = false;

  // 何度も参照するDOM要素はここでまとめて取得しておく
  const els = {
    messages: document.getElementById('messages'),
    seatGrid: document.getElementById('seat-grid'),
    overflowList: document.getElementById('overflow-list'),
    overflowAppend: document.getElementById('overflow-append'),
  };
  // overflow-append は再描画のたびに作り直される要素ではないため、
  // ドロップ受付は最初に1回だけ登録する（毎回登録するとリスナーが積み重なってしまう）
  makeDropTarget(els.overflowAppend, { type: 'overflow-append' });

  function initEmptyState() {
    const seats = {};
    for (const s of SEATS) seats[s.key] = [null, null];
    return seats;
  }

  // ---------- ファイル読み込み ----------
  function setupFileInput(inputId, statusId, key) {
    const input = document.getElementById(inputId);
    const status = document.getElementById(statusId);
    input.addEventListener('change', async () => {
      const file = input.files[0];
      if (!file) return;
      try {
        rawText[key] = await file.text();
        status.textContent = `読み込み済み: ${file.name}`;
        status.classList.remove('empty');
      } catch (e) {
        status.textContent = '読み込みに失敗しました';
        status.classList.add('empty');
      }
    });
  }
  setupFileInput('file-shift', 'status-shift', 'shift');
  setupFileInput('file-newbee', 'status-newbee', 'newbee');
  setupFileInput('file-secret', 'status-secret', 'secret');

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

  // ---------- 自動配置の実行 ----------
  document.getElementById('btn-run').addEventListener('click', () => {
    if (!rawText.shift || !rawText.newbee || !rawText.secret) {
      alert('shift.csv / newbee.csv / secret.csv をすべて選択してください。');
      return;
    }
    if (hasRunOnce) {
      const ok = confirm('手動で調整した内容は失われます。自動配置をやり直しますか？');
      if (!ok) return;
    }

    const shiftParsed = parseShiftRows(rawText.shift);
    const newbeeParsed = parseNewbeeRows(rawText.newbee);
    const secretParsed = parseSecretRows(rawText.secret, seatExists);

    const allLogs = [...shiftParsed.logs, ...newbeeParsed.logs, ...secretParsed.logs];

    const result = assignSeats(shiftParsed.rows, newbeeParsed.rows, secretParsed.rows);
    allLogs.push(...result.logs);

    appState.seats = result.state;
    appState.overflow = result.overflow;
    hasRunOnce = true;

    renderMessages(allLogs);
    render();

    // 個別ダイアログが必要なログのみ alert 表示
    allLogs.filter(l => l.showDialog).forEach(l => alert(l.message));
  });

  // ---------- 描画（座席グリッド・あふれ） ----------
  function personLabel(p) { return `${p.name} (${p.start}-${p.end})`; }

  function createPersonCard(loc, person) {
    const card = document.createElement('div');
    card.className = 'person-card' + (person.isNewbee ? ' newbee' : '');
    card.draggable = true;

    const nameLine = document.createElement('div');
    nameLine.className = 'name';
    const nameText = document.createElement('span');
    nameText.textContent = person.name;
    nameLine.appendChild(nameText);
    if (person.isNewbee) {
      const b = document.createElement('span'); b.className = 'badge newbee'; b.textContent = '新';
      nameLine.appendChild(b);
    }
    if (person.hasConstraint) {
      const b = document.createElement('span'); b.className = 'badge lock'; b.textContent = '🔒';
      nameLine.appendChild(b);
    }
    card.appendChild(nameLine);

    const timeLine = document.createElement('div');
    timeLine.className = 'time';
    timeLine.textContent = `${person.start} - ${person.end}`;
    card.appendChild(timeLine);

    card.addEventListener('dragstart', (e) => {
      dragSource = loc;
      e.dataTransfer.effectAllowed = 'move';
    });
    return card;
  }

  function getPersonAt(loc) {
    if (loc.type === 'seat') return appState.seats[loc.seatKey][loc.slotIndex];
    if (loc.type === 'overflow') return appState.overflow[loc.index];
    return null;
  }
  function setPersonAt(loc, person) {
    if (loc.type === 'seat') appState.seats[loc.seatKey][loc.slotIndex] = person;
    else if (loc.type === 'overflow') appState.overflow[loc.index] = person;
  }

  // ドラッグ元とドロップ先の中身を入れ替える（人単位の移動・交換）
  function handleDrop(target) {
    if (!dragSource) return;
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

  // 座席のスロット1つ分（空席 or 人物カード）とドロップ受付を作る
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
      slot.appendChild(createPersonCard(loc, person));
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
        coord.textContent = `${row},${col}`;
        seatDiv.appendChild(coord);

        seatDiv.appendChild(createSlot({ type: 'seat', seatKey: key, slotIndex: 0 }));
        seatDiv.appendChild(createSlot({ type: 'seat', seatKey: key, slotIndex: 1 }));

        grid.appendChild(seatDiv);
      }
    }
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
        wrapper.appendChild(createPersonCard(loc, person));
        makeDropTarget(wrapper, loc);
        list.appendChild(wrapper);
      });
    }
  }

  function render() {
    renderSeatGrid();
    renderOverflow();
  }
  render();

  // ドラッグがドロップ対象の外で終了した場合でも、ハイライトが残らないようにする
  document.addEventListener('dragend', () => {
    document.querySelectorAll('.dragover').forEach(el => el.classList.remove('dragover'));
  });

  // ---------- CSV 出力 ----------
  async function downloadBlob(blob, filename) {
    if (window.showSaveFilePicker) {
      try {
        const handle = await window.showSaveFilePicker({
          suggestedName: filename,
          types: [{ description: 'CSV', accept: { 'text/csv': ['.csv'] } }],
        });
        const writable = await handle.createWritable();
        await writable.write(blob);
        await writable.close();
        return;
      } catch (e) {
        if (e && e.name === 'AbortError') return; // ユーザーがキャンセル
        // それ以外の失敗時は通常のダウンロードにフォールバック
      }
    }
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = filename;
    document.body.appendChild(a); a.click(); a.remove();
    URL.revokeObjectURL(url);
  }

  document.getElementById('btn-export').addEventListener('click', async () => {
    const rows = [];
    rows.push(['1列目', '2列目', '3列目', '4列目', '', 'あふれ']);

    const overflowLabels = appState.overflow.map(personLabel);
    for (let row = 1; row <= 4; row++) {
      const cells = [];
      for (let col = 1; col <= 4; col++) {
        if (!seatExists(row, col)) { cells.push(''); continue; }
        const occ = appState.seats[`${row}-${col}`].filter(Boolean);
        cells.push(occ.map(personLabel).join('\n'));
      }
      cells.push('');
      cells.push(overflowLabels[row - 1] || '');
      rows.push(cells);
    }
    for (let i = 4; i < overflowLabels.length; i++) {
      rows.push(['', '', '', '', '', overflowLabels[i]]);
    }

    const csvText = '\uFEFF' + toCSV(rows);
    const blob = new Blob([csvText], { type: 'text/csv;charset=utf-8;' });

    const now = new Date();
    const pad = n => String(n).padStart(2, '0');
    const filename = `座席配置_${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}_${pad(now.getHours())}${pad(now.getMinutes())}.csv`;

    await downloadBlob(blob, filename);
  });

})(window.SeatTool);

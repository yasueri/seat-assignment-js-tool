// ============================================================
// csv.js
// CSVの読み書きと、shift.csv / rookie.csv / secret.csv それぞれの
// 解析・バリデーションを担当する。
// 他ファイルからは window.SeatTool.csv 経由で利用する。
// ============================================================
window.SeatTool = window.SeatTool || {};

window.SeatTool.csv = (function () {
  "use strict";

  // ---------- 汎用CSVパーサー（RFC4180簡易実装） ----------
  function parseCSV(text) {
    text = text.replace(/^\uFEFF/, ''); // BOM除去
    const rows = [];
    let row = [], field = '', inQuotes = false;
    for (let i = 0; i < text.length; i++) {
      const c = text[i];
      if (inQuotes) {
        if (c === '"') {
          if (text[i + 1] === '"') { field += '"'; i++; }
          else inQuotes = false;
        } else field += c;
      } else {
        if (c === '"') inQuotes = true;
        else if (c === ',') { row.push(field); field = ''; }
        else if (c === '\r') { /* skip */ }
        else if (c === '\n') { row.push(field); rows.push(row); row = []; field = ''; }
        else field += c;
      }
    }
    if (field.length > 0 || row.length > 0) { row.push(field); rows.push(row); }
    return rows.filter(r => !(r.length === 1 && r[0].trim() === ''));
  }

  // ---------- 時刻処理 ----------
  function timeToMinutes(str) {
    const m = String(str).trim().match(/^(\d{1,2}):(\d{2})$/);
    if (!m) return null;
    return parseInt(m[1], 10) * 60 + parseInt(m[2], 10);
  }

  // ---------- 日付処理 ----------
  // 「2026-06-01」「2026/6/1」「2026-6-1」「2026/06/01」のいずれの形式も受け付け、
  // ツール内部で統一して使う「YYYY-MM-DD」（ゼロ埋め・ハイフン区切り）に正規化する。
  // 形式が不正、または実在しない日付（2026/2/31など）の場合は null を返す。
  function normalizeDate(str) {
    const m = String(str).trim().match(/^(\d{4})[-\/](\d{1,2})[-\/](\d{1,2})$/);
    if (!m) return null;
    const y = parseInt(m[1], 10);
    const mo = parseInt(m[2], 10);
    const d = parseInt(m[3], 10);
    const dt = new Date(y, mo - 1, d);
    if (dt.getFullYear() !== y || dt.getMonth() !== mo - 1 || dt.getDate() !== d) return null;
    return `${y}-${String(mo).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
  }

  // ---------- 共通ヘルパー ----------
  function cell(row, index) { return (row[index] || '').trim(); }

  // ヘッダー行が想定と違う場合に警告を出す（処理自体は列の位置で続行する）
  function checkHeader(raw, expectedLabels, fileLabel, logs) {
    const header = (raw[0] || []).map(h => (h || '').trim());
    const mismatch = expectedLabels.some((label, i) => header[i] !== label);
    if (mismatch) {
      logs.push({
        level: 'warn',
        message: `${fileLabel}のヘッダー行が想定と異なります（想定: ${expectedLabels.join(', ')} / 実際: ${header.join(', ') || '(空)'}）。列の並び順をご確認ください。`,
      });
    }
  }

  // ---------- 夜勤・遅番の判定 ----------
  // 夜勤: 開始時刻が22:00より遅い、または終了時刻が26:00より遅い（日跨ぎの延長表記。例: 32:00 = 翌8:00）
  // 対象は役割=OPのスタッフのみ。既存の座席グリッドには配置しない（ver3.0で対応予定）。
  const NIGHT_START_THRESHOLD = timeToMinutes('22:00'); // 1320
  const NIGHT_END_THRESHOLD = timeToMinutes('26:00');   // 1560
  function isNightShift(startMin, endMin) {
    return startMin > NIGHT_START_THRESHOLD || endMin > NIGHT_END_THRESHOLD;
  }

  // 遅番: 開始時刻が12:00以降、または（前残業がTRUEかつ開始時刻が10:00以降）
  // 対象は役割=役席・GLのスタッフの「早番エリア」「遅番エリア」振り分けに使用する。
  const LATE_START_THRESHOLD = timeToMinutes('12:00');      // 720
  const LATE_OT_START_THRESHOLD = timeToMinutes('10:00');   // 600
  function isLateShift(startMin, frontOT) {
    return startMin >= LATE_START_THRESHOLD || (!!frontOT && startMin >= LATE_OT_START_THRESHOLD);
  }

  // ---------- 前残業・後残業（TRUE/FALSE） ----------
  function parseBoolFlag(raw, name, colLabel, rowLabel, logs) {
    const v = String(raw == null ? '' : raw).trim().toUpperCase();
    if (v === 'TRUE') return true;
    if (v === 'FALSE' || v === '') return false;
    logs.push({ level: 'warn', message: `${rowLabel}: ${colLabel}の値「${raw}」を認識できないため「FALSE」として扱いました（${name}）` });
    return false;
  }

  // ---------- 月間シフトCSV ----------
  // 列: 日付,氏名,開始時刻,終了時刻,前残業,後残業,役割
  // 1か月分の全出勤情報を受け取り、日付ごとに抽出できる形で返す。
  // 役割は「役席」「GL」「OP」のいずれか。
  function parseShiftMonthlyRows(text) {
    const logs = [];
    const raw = parseCSV(text);
    checkHeader(raw, ['日付', '氏名', '開始時刻', '終了時刻', '前残業', '後残業', '役割'], '月間シフトCSV', logs);

    const dataRows = raw.slice(1);
    const result = [];
    const seenKeys = new Set(); // "日付|氏名" の重複チェック
    const dateSet = new Set();

    dataRows.forEach((r, i) => {
      const rowLabel = `月間シフトCSV ${i + 2}行目`;
      const rawDate = cell(r, 0);
      const name = cell(r, 1);
      const start = cell(r, 2);
      const end = cell(r, 3);
      const frontRaw = cell(r, 4);
      const backRaw = cell(r, 5);
      const role = cell(r, 6);
      if (!rawDate && !name) return; // 完全な空行

      // 「2026-06-01」「2026/6/1」などを内部形式「YYYY-MM-DD」に正規化する
      const date = normalizeDate(rawDate);
      if (!date) {
        logs.push({ level: 'warn', message: `${rowLabel}: 日付の形式（YYYY-MM-DD または YYYY/M/D）が不正なため読み飛ばしました（${rawDate || '空欄'}）` });
        return;
      }
      if (!name) {
        logs.push({ level: 'warn', message: `${rowLabel}: 氏名が空欄のため読み飛ばしました` });
        return;
      }
      const startMin = timeToMinutes(start);
      const endMin = timeToMinutes(end);
      if (startMin == null || endMin == null) {
        logs.push({ level: 'warn', message: `${rowLabel}: 時刻の形式が不正なため読み飛ばしました（${name}）` });
        return;
      }
      if (startMin >= endMin) {
        logs.push({ level: 'warn', message: `${rowLabel}: 開始時刻が終了時刻以降になっているため読み飛ばしました（${name}）` });
        return;
      }
      if (role !== '役席' && role !== 'GL' && role !== 'OP') {
        logs.push({ level: 'warn', message: `${rowLabel}: 役割「${role}」は認識できません（役席・GL・OPのいずれか）。読み飛ばしました（${name}）` });
        return;
      }
      const key = `${date}|${name}`;
      if (seenKeys.has(key)) {
        logs.push({ level: 'error', message: `${rowLabel}: ${date}の「${name}」が複数回記載されています。最初の行のみ使用します。` });
        return;
      }
      seenKeys.add(key);

      const frontOT = parseBoolFlag(frontRaw, name, '前残業', rowLabel, logs);
      const backOT = parseBoolFlag(backRaw, name, '後残業', rowLabel, logs);

      dateSet.add(date);
      result.push({
        date, name, start, end, startMin, endMin, role, frontOT, backOT,
        nightShift: isNightShift(startMin, endMin),
        lateShift: isLateShift(startMin, frontOT),
      });
    });

    return { rows: result, logs, dates: Array.from(dateSet).sort() };
  }

  // 指定した日付の行だけを抜き出す
  function rowsForDate(rows, date) {
    return rows.filter(r => r.date === date);
  }

  // dates（ソート済みのYYYY-MM-DD配列）から「2026年6月」のようなラベルを作る
  function yearMonthLabelFromDates(dates) {
    if (!dates || dates.length === 0) return '';
    const m = dates[0].match(/^(\d{4})-(\d{2})-\d{2}$/);
    if (!m) return '';
    return `${parseInt(m[1], 10)}年${parseInt(m[2], 10)}月`;
  }

  // ---------- rookie.csv ----------
  function parseRookieRows(text) {
    const logs = [];
    const raw = parseCSV(text);
    checkHeader(raw, ['氏名', '新人度合い'], 'rookie.csv', logs);

    const dataRows = raw.slice(1);
    const result = [];
    const seenNames = new Set();

    dataRows.forEach((r, i) => {
      const name = cell(r, 0);
      const degree = parseFloat(r[1]);
      if (!name) return;
      if (isNaN(degree)) {
        logs.push({ level: 'warn', message: `rookie.csv ${i + 2}行目: 新人度合いが数値ではないため読み飛ばしました（${name}）` });
        return;
      }
      if (seenNames.has(name)) {
        logs.push({ level: 'warn', message: `rookie.csv ${i + 2}行目: 「${name}」が複数回記載されています。最初の行のみ使用します。` });
        return;
      }
      seenNames.add(name);
      result.push({ name, degree });
    });

    return { rows: result, logs };
  }

  // 全角数字を半角に変換する（優先フラグ列の数値を半角・全角どちらでも受け付けるため）
  function normalizeDigits(str) {
    return String(str).replace(/[０-９]/g, ch => String.fromCharCode(ch.charCodeAt(0) - 0xFEE0));
  }

  // ---------- secret.csv ----------
  // seatByNumber は algorithm.js が提供する（座席番号 -> {row,col} の変換・妥当性チェックに使用）
  // 「禁止席」「固定席」「要サポート」の対象座席は、半角または全角スペース区切りで
  // 複数指定できる。「固定席」の対象座席には、座席番号（1〜15）に加えて特別な値
  // 「夜勤GL席」も指定できる（夜勤の役席・GLが複数名いる日に、夜勤GL枠2行1列目へ
  // 優先的に入れたい人を指定するため）。「夜勤GL席」は固定席でのみ有効
  // （禁止席・要サポートには指定できない）。座席番号と混在も可能
  // （例: 「夜勤GL席 3」＝夜勤GL枠か3番のどちらか）。
  // 「要サポート」は、新人は卒業したが独り立ちまであと一歩のスタッフを表す種別で、
  // 入力形式（対象座席の複数指定・入力順が優先順位になる点も含め）は固定席と全く同じ。
  // 同じ人が複数行に分かれて書かれている場合は duplicateDesignatedNames /
  // duplicateForbiddenNames / duplicateSupportNames として検出し、呼び出し側で
  // 配置を止める判断に使う。
  // 5列目「優先フラグ」は種別を問わずどの行にも指定でき、対象1の氏名に対して
  // 適用される（半角・全角どちらの数字も可）。値が入っている場合、その人は他の
  // どの配置ルールよりも先に処理される（数値が小さいほど優先。複数行にまたがって
  // 別の値が入力されていた場合は最小値を採用する）。
  function parseSecretRows(text, seatByNumber) {
    const logs = [];
    const raw = parseCSV(text);
    checkHeader(raw, ['種別', '対象1', '対象2', '対象座席', '優先フラグ'], 'secret.csv', logs);

    const dataRows = raw.slice(1);
    const result = [];
    const seenDesignated = new Set();
    const seenForbidden = new Set();
    const seenSupport = new Set();
    const duplicateDesignated = new Set();
    const duplicateForbidden = new Set();
    const duplicateSupport = new Set();

    dataRows.forEach((r, i) => {
      const type = cell(r, 0);
      const targetNameForFlag = cell(r, 1); // 優先フラグは対象1の氏名に対して適用する
      const flagCell = cell(r, 4);
      if (flagCell) {
        if (!targetNameForFlag) {
          logs.push({ level: 'warn', message: `secret.csv ${i + 2}行目: 優先フラグが入力されていますが対象1が空欄のため無視しました` });
        } else {
          const normalized = normalizeDigits(flagCell).trim();
          if (/^\d+$/.test(normalized)) {
            result.push({ type: 'priority_flag', name: targetNameForFlag, flag: parseInt(normalized, 10) });
          } else {
            logs.push({ level: 'warn', message: `secret.csv ${i + 2}行目: 優先フラグ「${flagCell}」は数値として認識できません` });
          }
        }
      }

      if (type === '隣接禁止') {
        const name1 = cell(r, 1);
        const name2 = cell(r, 2);
        if (!name1 || !name2) {
          logs.push({ level: 'warn', message: `secret.csv ${i + 2}行目: 隣接禁止の対象者名が不足しています` });
          return;
        }
        result.push({ type: 'adjacent_forbidden', name1, name2 });
      } else if (type === '禁止席' || type === '固定席' || type === '要サポート') {
        const name = cell(r, 1);
        const seatCell = cell(r, 3);
        if (!name || !seatCell) {
          logs.push({ level: 'warn', message: `secret.csv ${i + 2}行目: ${type}の情報が不足しています` });
          return;
        }
        const kind = type === '禁止席' ? 'seat_forbidden' : (type === '固定席' ? 'seat_designated' : 'seat_support');
        const seenSet = kind === 'seat_forbidden' ? seenForbidden : (kind === 'seat_designated' ? seenDesignated : seenSupport);
        const dupSet = kind === 'seat_forbidden' ? duplicateForbidden : (kind === 'seat_designated' ? duplicateDesignated : duplicateSupport);
        if (seenSet.has(name)) dupSet.add(name);
        seenSet.add(name);

        // 半角・全角スペースどちらでも区切りとして認める（同じ行内の重複番号は1つにまとめる）
        const tokens = seatCell.split(/[ \u3000]+/).filter(Boolean);
        const seenNumsInRow = new Set();
        tokens.forEach(tok => {
          if (tok === '夜勤GL席') {
            if (kind !== 'seat_designated') {
              logs.push({ level: 'warn', message: `secret.csv ${i + 2}行目: 「夜勤GL席」は固定席でのみ指定できます（禁止席・要サポートには指定できません）` });
              return;
            }
            result.push({ type: 'night_gl_designated', name });
            return;
          }
          if (!/^\d+$/.test(tok)) {
            logs.push({ level: 'warn', message: `secret.csv ${i + 2}行目: 「${tok}」は座席番号として認識できません` });
            return;
          }
          const seatNum = parseInt(tok, 10);
          const seat = seatByNumber(seatNum);
          if (!seat) {
            logs.push({ level: 'warn', message: `secret.csv ${i + 2}行目: 座席番号${seatNum}は存在しません` });
            return;
          }
          if (seenNumsInRow.has(seatNum)) return;
          seenNumsInRow.add(seatNum);
          result.push({ type: kind, name, row: seat.row, col: seat.col });
        });
      } else {
        logs.push({ level: 'warn', message: `secret.csv ${i + 2}行目: 種別「${type}」は認識できません（「隣接禁止」「禁止席」「固定席」「要サポート」のいずれか）` });
      }
    });

    return {
      rows: result,
      logs,
      duplicateDesignatedNames: Array.from(duplicateDesignated),
      duplicateForbiddenNames: Array.from(duplicateForbidden),
      duplicateSupportNames: Array.from(duplicateSupport),
    };
  }

  // ---------- ojt.csv ----------
  // 列: 教官名, OJT一人目, OJT二人目, 対象座席
  // 教官1名につき1行。OJT二人目は空欄でよい（その日の担当が1名のみの場合）。
  // 対象座席は「単独配置（教官とOJT一人目のみが同席する場合）」の候補座席を
  // 優先順で指定する。空欄なら既定順（15→12→8→他）。座席番号を書くとその座席が
  // 先頭に来て、残りは既定順のまま続く（例:「12」→12→15→8→他、
  // 「12 4」→12→4→15→8→他）。半角・全角スペースどちらでも区切りとして使える。
  // OJT二人目がいる場合のペア席探索順は、この対象座席から算出する「単独時の順で
  // 12と15のどちらが先に来るか」によって決まる（詳しい組み合わせはalgorithm.js側の
  // 固定値・readme.txtを参照）。ojt.csv自体にペアの座席番号を書く必要はない。
  function parseOjtRows(text, seatByNumber) {
    const logs = [];
    const raw = parseCSV(text);
    checkHeader(raw, ['教官名', 'OJT一人目', 'OJT二人目', '対象座席'], 'ojt.csv', logs);

    const dataRows = raw.slice(1);
    const result = [];
    const seenMentors = new Set();
    const duplicateMentors = new Set();
    const traineeOwner = new Map(); // OJT対象者名 -> 最初に見つかった教官名（重複検出用）
    const duplicateTrainees = new Set();

    dataRows.forEach((r, i) => {
      const rowLabel = `ojt.csv ${i + 2}行目`;
      const mentorName = cell(r, 0);
      const ojt1 = cell(r, 1);
      const ojt2 = cell(r, 2);
      const seatCell = cell(r, 3);
      if (!mentorName && !ojt1 && !ojt2 && !seatCell) return; // 完全な空行

      if (!mentorName) {
        logs.push({ level: 'warn', message: `${rowLabel}: 教官名が空欄のため読み飛ばしました` });
        return;
      }
      if (!ojt1) {
        logs.push({ level: 'warn', message: `${rowLabel}: OJT一人目が空欄のため読み飛ばしました（${mentorName}）` });
        return;
      }
      if (ojt2 && ojt2 === ojt1) {
        logs.push({ level: 'warn', message: `${rowLabel}: OJT一人目とOJT二人目に同じ氏名（${ojt1}）が指定されています。読み飛ばしました` });
        return;
      }
      if (seenMentors.has(mentorName)) {
        duplicateMentors.add(mentorName);
        logs.push({ level: 'error', message: `ojt.csv: 教官「${mentorName}」が複数行に記載されています。1名につき1行にまとめてください。` });
        return;
      }
      seenMentors.add(mentorName);

      const trainees = [ojt1, ojt2].filter(Boolean);
      trainees.forEach(name => {
        if (traineeOwner.has(name) && traineeOwner.get(name) !== mentorName) {
          duplicateTrainees.add(name);
          logs.push({ level: 'error', message: `ojt.csv: OJT対象者「${name}」が複数の教官（${traineeOwner.get(name)}・${mentorName}）に紐づいています。` });
        }
        traineeOwner.set(name, mentorName);
      });

      // 対象座席: 半角・全角スペース区切りで複数指定できる（先頭に来る優先順）
      const seatOrder = [];
      if (seatCell) {
        const tokens = seatCell.split(/[ \u3000]+/).filter(Boolean);
        tokens.forEach(tok => {
          if (!/^\d+$/.test(tok)) {
            logs.push({ level: 'warn', message: `${rowLabel}: 「${tok}」は座席番号として認識できません` });
            return;
          }
          const seatNum = parseInt(tok, 10);
          const seat = seatByNumber(seatNum);
          if (!seat) {
            logs.push({ level: 'warn', message: `${rowLabel}: 座席番号${seatNum}は存在しません` });
            return;
          }
          if (!seatOrder.includes(seatNum)) seatOrder.push(seatNum);
        });
      }

      result.push({ mentorName, trainees, seatOrder });
    });

    return {
      rows: result,
      logs,
      duplicateMentorNames: Array.from(duplicateMentors),
      duplicateTraineeNames: Array.from(duplicateTrainees),
    };
  }

  return {
    parseCSV, timeToMinutes, normalizeDate,
    parseShiftMonthlyRows, rowsForDate, yearMonthLabelFromDates,
    isNightShift, isLateShift,
    parseRookieRows, parseSecretRows, parseOjtRows,
  };
})();
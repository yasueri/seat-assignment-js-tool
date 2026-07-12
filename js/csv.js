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

  // ---------- secret.csv ----------
  // seatByNumber は algorithm.js が提供する（座席番号 -> {row,col} の変換・妥当性チェックに使用）
  // 「禁止席」「席固定」の対象座席は、半角または全角スペース区切りで複数指定できる。
  // 「席固定」の対象座席には、座席番号（1〜15）に加えて特別な値「夜勤GL席」も指定できる
  // （夜勤の役席・GLが複数名いる日に、夜勤GL枠2行1列目へ優先的に入れたい人を指定するため）。
  // 「夜勤GL席」は席固定でのみ有効（禁止席には指定できない）。座席番号と混在も可能
  // （例: 「夜勤GL席 3」＝夜勤GL枠か3番のどちらか）。
  // 同じ人が複数行に分かれて書かれている場合は duplicateDesignatedNames /
  // duplicateForbiddenNames として検出し、呼び出し側で配置を止める判断に使う。
  function parseSecretRows(text, seatByNumber) {
    const logs = [];
    const raw = parseCSV(text);
    checkHeader(raw, ['種別', '対象1', '対象2', '対象座席'], 'secret.csv', logs);

    const dataRows = raw.slice(1);
    const result = [];
    const seenDesignated = new Set();
    const seenForbidden = new Set();
    const duplicateDesignated = new Set();
    const duplicateForbidden = new Set();

    dataRows.forEach((r, i) => {
      const type = cell(r, 0);
      if (type === '隣接禁止') {
        const name1 = cell(r, 1);
        const name2 = cell(r, 2);
        if (!name1 || !name2) {
          logs.push({ level: 'warn', message: `secret.csv ${i + 2}行目: 隣接禁止の対象者名が不足しています` });
          return;
        }
        result.push({ type: 'adjacent_forbidden', name1, name2 });
      } else if (type === '禁止席' || type === '席固定') {
        const name = cell(r, 1);
        const seatCell = cell(r, 3);
        if (!name || !seatCell) {
          logs.push({ level: 'warn', message: `secret.csv ${i + 2}行目: ${type}の情報が不足しています` });
          return;
        }
        const kind = type === '禁止席' ? 'seat_forbidden' : 'seat_designated';
        const seenSet = kind === 'seat_forbidden' ? seenForbidden : seenDesignated;
        const dupSet = kind === 'seat_forbidden' ? duplicateForbidden : duplicateDesignated;
        if (seenSet.has(name)) dupSet.add(name);
        seenSet.add(name);

        // 半角・全角スペースどちらでも区切りとして認める（同じ行内の重複番号は1つにまとめる）
        const tokens = seatCell.split(/[ \u3000]+/).filter(Boolean);
        const seenNumsInRow = new Set();
        tokens.forEach(tok => {
          if (tok === '夜勤GL席') {
            if (kind !== 'seat_designated') {
              logs.push({ level: 'warn', message: `secret.csv ${i + 2}行目: 「夜勤GL席」は席固定でのみ指定できます（禁止席には指定できません）` });
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
        logs.push({ level: 'warn', message: `secret.csv ${i + 2}行目: 種別「${type}」は認識できません（「隣接禁止」「禁止席」「席固定」のいずれか）` });
      }
    });

    return {
      rows: result,
      logs,
      duplicateDesignatedNames: Array.from(duplicateDesignated),
      duplicateForbiddenNames: Array.from(duplicateForbidden),
    };
  }

  return {
    parseCSV, timeToMinutes, normalizeDate,
    parseShiftMonthlyRows, rowsForDate, yearMonthLabelFromDates,
    isNightShift, isLateShift,
    parseRookieRows, parseSecretRows,
  };
})();
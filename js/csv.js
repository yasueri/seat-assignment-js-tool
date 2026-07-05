// ============================================================
// csv.js
// CSVの読み書きと、shift.csv / newbee.csv / secret.csv それぞれの
// 解析・バリデーションを担当する。
// 他ファイルからは window.SeatTool.csv 経由で利用する。
// ============================================================
window.SeatTool = window.SeatTool || {};

window.SeatTool.csv = (function () {
  "use strict";

  // ---------- 汎用CSVパーサー / ライター（RFC4180簡易実装） ----------
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

  function csvField(value) {
    const s = String(value == null ? '' : value);
    if (/[",\n]/.test(s)) return '"' + s.replace(/"/g, '""') + '"';
    return s;
  }

  function toCSV(rows) {
    return rows.map(r => r.map(csvField).join(',')).join('\r\n');
  }

  // ---------- 時刻処理 ----------
  function timeToMinutes(str) {
    const m = String(str).trim().match(/^(\d{1,2}):(\d{2})$/);
    if (!m) return null;
    return parseInt(m[1], 10) * 60 + parseInt(m[2], 10);
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

  // ---------- shift.csv ----------
  function parseShiftRows(text) {
    const logs = [];
    const raw = parseCSV(text);
    checkHeader(raw, ['氏名', '出勤時刻', '退勤時刻'], 'shift.csv', logs);

    const dataRows = raw.slice(1);
    const result = [];
    const seenNames = new Set();

    dataRows.forEach((r, i) => {
      const name = cell(r, 0);
      const start = cell(r, 1);
      const end = cell(r, 2);
      if (!name) return;

      const startMin = timeToMinutes(start);
      const endMin = timeToMinutes(end);
      if (startMin == null || endMin == null) {
        logs.push({ level: 'warn', message: `shift.csv ${i + 2}行目: 時刻の形式が不正なため読み飛ばしました（${name}）` });
        return;
      }
      if (startMin >= endMin) {
        logs.push({ level: 'warn', message: `shift.csv ${i + 2}行目: 出勤時刻が退勤時刻以降になっているため読み飛ばしました（${name}）` });
        return;
      }
      if (seenNames.has(name)) {
        logs.push({ level: 'error', message: `shift.csv ${i + 2}行目: 「${name}」が複数回記載されています。同一人物として扱い、最初の行のみ使用します。` });
        return;
      }
      seenNames.add(name);
      result.push({ name, start, end, startMin, endMin });
    });

    return { rows: result, logs };
  }

  // ---------- newbee.csv ----------
  function parseNewbeeRows(text) {
    const logs = [];
    const raw = parseCSV(text);
    checkHeader(raw, ['氏名', '新人度合い'], 'newbee.csv', logs);

    const dataRows = raw.slice(1);
    const result = [];
    const seenNames = new Set();

    dataRows.forEach((r, i) => {
      const name = cell(r, 0);
      const degree = parseFloat(r[1]);
      if (!name) return;
      if (isNaN(degree)) {
        logs.push({ level: 'warn', message: `newbee.csv ${i + 2}行目: 新人度合いが数値ではないため読み飛ばしました（${name}）` });
        return;
      }
      if (seenNames.has(name)) {
        logs.push({ level: 'warn', message: `newbee.csv ${i + 2}行目: 「${name}」が複数回記載されています。最初の行のみ使用します。` });
        return;
      }
      seenNames.add(name);
      result.push({ name, degree });
    });

    return { rows: result, logs };
  }

  // ---------- secret.csv ----------
  // seatExists は algorithm.js が提供する（座標の妥当性チェックに使用）
  function parseSecretRows(text, seatExists) {
    const logs = [];
    const raw = parseCSV(text);
    checkHeader(raw, ['種別', '対象1', '対象2', '禁止行', '禁止列'], 'secret.csv', logs);

    const dataRows = raw.slice(1);
    const result = [];

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
      } else if (type === '座席禁止') {
        const name = cell(r, 1);
        const rowNum = parseInt(r[3], 10);
        const colNum = parseInt(r[4], 10);
        if (!name || isNaN(rowNum) || isNaN(colNum)) {
          logs.push({ level: 'warn', message: `secret.csv ${i + 2}行目: 座席禁止の情報が不足しています` });
          return;
        }
        if (!seatExists(rowNum, colNum)) {
          logs.push({ level: 'warn', message: `secret.csv ${i + 2}行目: 座席(${rowNum},${colNum}) は存在しません` });
          return;
        }
        result.push({ type: 'seat_forbidden', name, row: rowNum, col: colNum });
      } else {
        logs.push({ level: 'warn', message: `secret.csv ${i + 2}行目: 種別「${type}」は認識できません（「隣接禁止」または「座席禁止」）` });
      }
    });

    return { rows: result, logs };
  }

  return {
    parseCSV, csvField, toCSV, timeToMinutes,
    parseShiftRows, parseNewbeeRows, parseSecretRows,
  };
})();

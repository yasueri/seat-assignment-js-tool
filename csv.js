// ============================================================
// csv.js
// CSVの読み書きと、shift.csv / rookie.csv / secret.csv / ojt.csv それぞれの
// 解析・バリデーションを担当する。
// 月間シフトCSVは、同日・同一氏名でも時間帯が重ならなければ複数行を受け入れる
// （同日2回勤務＝応援勤務。ver0.4.18で追加）。重なる場合のみ従来どおりerrorで弾く。
// 受け入れた各行には pkey（氏名|開始時刻）を付与し、下流で1件ずつ区別できるようにする。
// 氏名は読み込みの時点で月間シフトCSVの表記に揃える（ver0.5.6で追加。氏名処理を参照）。
// 下流（ui.js / algorithm.js）は「氏名の表記は揃っている」前提で照合してよい。
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

  // ---------- 氏名処理 ----------
  // 〈ver0.5.6で追加〉
  // 月間シフトCSVと設定ファイル（secret.csv / ojt.csv / rookie.csv）で姓名の間の
  // スペースの入れ方が違うと、これまでは別人として扱われ、固定席・新人固定席・OJT・
  // 要サポート・禁止席・隣接禁止・優先フラグが黙って効かなくなっていた。
  // 座席表を見ても普通に座っているだけなので気づけないため、読み込みの時点で吸収する。
  //
  // 照合と表示で必要な形が違うため、関数を2つに分けている。
  //   nameKey     … 照合用のキー。空白をすべて取り除く（山田 太郎 → 山田太郎）
  //   displayName … 画面・印刷に出す氏名。連続する空白を半角スペース1つに詰める
  //
  // JSの \s は全角スペース（U+3000）・ノーブレークスペース（U+00A0）・タブ・改行を含むため、
  // どの空白で書かれていても同じキーになる。
  // 全角英数字と半角英数字の同一視、旧字体・異体字の同一視（髙／高など）は対象外。
  function nameKey(s) {
    return String(s == null ? '' : s).replace(/\s+/g, '');
  }

  // 表示用の氏名。VBAの出力（ExportShiftCSV）は氏名を元Excelの生の値で書き出しているため、
  // 氏名セルに改行・タブ・二重スペースが入っているとそのままCSVに出て座席カードの
  // レイアウトが崩れる。ここで吸収する。
  function displayName(s) {
    return String(s == null ? '' : s).replace(/\s+/g, ' ').trim();
  }

  // 月間シフトCSVの氏名を対応表（nameKey -> 表記）に登録し、採用する表記を返す。
  // 既に同じキーが登録されていれば、そのCSVで最初に出てきた表記に揃える。
  function registerName(nameMap, raw) {
    const disp = displayName(raw);
    if (!disp) return '';
    const key = nameKey(disp);
    if (!nameMap.has(key)) nameMap.set(key, disp);
    return nameMap.get(key);
  }

  // ---------- 時刻処理 ----------
  // 「9:00」「34:00」のほか、秒付きの「34:00:00」も受け付ける（秒は切り捨て）。〈ver0.5.4で追加〉
  // Excelはcsvの24時以降の時刻を「1900/1/1 10:00」という日時として保持しており、
  // Excelで開いて保存し直すと「34:00」が「34:00:00」に書き換わってしまうため。
  // 利用者のPCではcsvの既定アプリがExcelになっている前提で、ツール側で吸収する。
  function timeToMinutes(str) {
    const m = String(str).trim().match(/^(\d{1,2}):([0-5]\d)(?::[0-5]\d)?$/);
    if (!m) return null;
    return parseInt(m[1], 10) * 60 + parseInt(m[2], 10);
  }

  // 時刻の表記を「H:MM」に統一する。形式が不正な場合は null を返す。〈ver0.5.4で追加〉
  // 時刻の文字列は画面表示のほか pkey（氏名|開始時刻）にも使われるため、
  // 「34:00:00」「09:00」などの表記ゆれをそのまま通すと、同じ人の同じ勤務が
  // 別人と判定されてしまう。読み込み・手入力の時点でここを通して揃える。
  function normalizeTime(str) {
    const min = timeToMinutes(str);
    if (min == null) return null;
    return `${Math.floor(min / 60)}:${String(min % 60).padStart(2, '0')}`;
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
  // 対象は役割=OPのスタッフのみ。夜勤専用の座席グリッド（夜勤パネル）に配置する。
  const NIGHT_START_THRESHOLD = timeToMinutes('22:00'); // 1320
  const NIGHT_END_THRESHOLD = timeToMinutes('26:00');   // 1560
  function isNightShift(startMin, endMin) {
    return startMin > NIGHT_START_THRESHOLD || endMin > NIGHT_END_THRESHOLD;
  }

  // 遅番: 開始時刻が12:00以降、または（前残業ありかつ開始時刻が10:00以降）
  // 対象は役割=役席・GLのスタッフの「早番エリア」「遅番エリア」振り分けに使用する。
  const LATE_START_THRESHOLD = timeToMinutes('12:00');      // 720
  const LATE_OT_START_THRESHOLD = timeToMinutes('10:00');   // 600
  // frontOT は残業の種別（'' / 'OP' / 'GL'）。OP・GLどちらの残業でも「前残業あり」として
  // 同じように扱うため、種別は見ずに「残業かどうか」だけを判定する。〈ver0.5.5〉
  function isLateShift(startMin, frontOT) {
    return startMin >= LATE_START_THRESHOLD || (!!frontOT && startMin >= LATE_OT_START_THRESHOLD);
  }

  // ---------- 前残業・後残業（残業の種別） ----------
  // 〈ver0.5.5で TRUE/FALSE の2値から変更〉
  // 残業には「OPとしての残業」と「GL業務での残業」の2種類があり、座席表で
  // 見分けられる必要があるため、有無だけでなく種別まで持つようにした。
  //   'OP' … OPとしての残業。画面・印刷とも 黄色マーカー＋「※」
  //   'GL' … GL業務での残業。画面・印刷とも 緑色マーカー＋「◆」
  //   ''   … 残業なし
  // 戻り値を文字列にしたことで、'OP'・'GL' はどちらも真、'' は偽として評価される。
  // そのため「残業かどうか」だけを見ている箇所（isLateShift など）は変更不要。
  //
  // 入力の表記ゆれは、CSVを手で直した場合に備えてここで吸収する。
  // 旧仕様の TRUE は、実運用で大多数を占める OP残業として読み込む。
  function parseOTKind(raw, name, colLabel, rowLabel, logs) {
    const v = String(raw == null ? '' : raw).trim().toUpperCase();
    if (v === '' || v === 'FALSE') return '';
    if (v === 'OP' || v === 'OP残業') return 'OP';
    if (v === 'GL' || v === 'GL残業') return 'GL';
    if (v === 'TRUE') return 'OP';
    logs.push({ level: 'warn', message: `${rowLabel}: ${colLabel}の値「${raw}」を認識できないため「残業なし」として扱いました（${name}）。OP・GL・空欄のいずれかで入力してください。` });
    return '';
  }

  // 保存ファイルなど、CSV以外から来た残業種別を安全な値に丸める。
  // 想定外の値は「残業なし」に倒す（誤った記号を紙に出さないため）。
  function normalizeOTKind(v) {
    return (v === 'OP' || v === 'GL') ? v : '';
  }

  // ---------- 月間シフトCSV ----------
  // 列: 日付,氏名,開始時刻,終了時刻,前残業,後残業,役割
  // 1か月分の全出勤情報を受け取り、日付ごとに抽出できる形で返す。
  // 役割は「役席」「GL」「OP」のいずれか。
  // 前残業・後残業は「OP」「GL」「空欄」のいずれか（parseOTKind を参照）。
  // 戻り値の nameMap は「空白を除いた氏名 -> このCSVでの表記」の対応表〈ver0.5.6で追加〉。
  // 設定ファイルを読むときに resolveName としてこれを引き、氏名の表記を揃える。
  function parseShiftMonthlyRows(text) {
    const logs = [];
    const raw = parseCSV(text);
    checkHeader(raw, ['日付', '氏名', '開始時刻', '終了時刻', '前残業', '後残業', '役割'], '月間シフトCSV', logs);

    const dataRows = raw.slice(1);
    const result = [];
    // "日付|氏名" -> その日その人の受け入れ済み勤務時間帯の配列。
    // 同日2回勤務の時間重複判定に使う。〈ver0.4.18で Set から Map に変更〉
    const seenShifts = new Map();
    const dateSet = new Set();
    // 空白を除いた氏名（nameKey）-> このCSVで最初に出てきた表記。〈ver0.5.6で追加〉
    // 設定ファイル側の氏名を「その月の正しい表記」に寄せるための対応表。
    // 同じキーが後から出てきた場合は最初の表記に揃えるため、月間シフトCSVの中で
    // 表記が混在していても1人として扱われる。
    const nameMap = new Map();

    dataRows.forEach((r, i) => {
      const rowLabel = `月間シフトCSV ${i + 2}行目`;
      const rawDate = cell(r, 0);
      // 氏名はここで表記を整え、以降（重複判定・pkey・画面表示）はこの表記だけを使う。
      // 読み飛ばす行の氏名も対応表に載せる。載せた表記を必ずこの行でも使うため、
      // 「読み飛ばした行の表記が採用され、生き残った行と食い違う」ことは起きない。
      const name = registerName(nameMap, cell(r, 1));
      // 表記ゆれを吸収するため、検証後に normalizeTime で書き換える。〈ver0.5.4〉
      let start = cell(r, 2);
      let end = cell(r, 3);
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
      // ここから下（重複判定・pkey・画面表示）は「H:MM」に揃った表記だけを使う。〈ver0.5.4〉
      start = normalizeTime(start);
      end = normalizeTime(end);
      if (role !== '役席' && role !== 'GL' && role !== 'OP') {
        logs.push({ level: 'warn', message: `${rowLabel}: 役割「${role}」は認識できません（役席・GL・OPのいずれか）。読み飛ばしました（${name}）` });
        return;
      }
      // 同日・同一氏名の複数行（同日2回勤務）の扱い。〈ver0.4.18で変更〉
      // 応援勤務などで、1人が同じ日に間の空いた別々の時間帯で出勤することがある。
      // 時間帯が重ならなければ両方とも受け入れ、両方とも座席配置の対象にする。
      // 時間帯が重なる場合は明らかな入力ミスとみなし、従来どおりerrorで弾く。
      const key = `${date}|${name}`;
      const previous = seenShifts.get(key);
      if (previous) {
        const conflict = previous.find(
          prev => startMin < prev.endMin && prev.startMin < endMin
        );
        if (conflict) {
          logs.push({ level: 'error', message: `${rowLabel}: ${date}の「${name}」が時間帯の重なる勤務として複数回記載されています（${conflict.start}-${conflict.end} / ${start}-${end}）。この行は読み飛ばしました。` });
          return;
        }
        // 重なりなし＝受け入れる。例外的な勤務のため注意は促す。
        const allTimes = [...previous, { start, end }]
          .map(s => `${s.start}-${s.end}`).join(' / ');
        logs.push({ level: 'warn', message: `${date}の「${name}」が${previous.length + 1}回出勤として登録されています（${allTimes}）。応援勤務でなければ入力をご確認ください。` });
        previous.push({ start, end, startMin, endMin });
      } else {
        seenShifts.set(key, [{ start, end, startMin, endMin }]);
      }

      const frontOT = parseOTKind(frontRaw, name, '前残業', rowLabel, logs);
      const backOT = parseOTKind(backRaw, name, '後残業', rowLabel, logs);

      dateSet.add(date);
      result.push({
        date, name, start, end, startMin, endMin, role, frontOT, backOT,
        // 同日2回勤務を区別するための識別子。〈ver0.4.18で追加〉
        // 同日・同一氏名で開始時刻が重複することはない（重なる勤務はerrorで弾くため）
        // ので、氏名＋開始時刻で一意になる。氏名だけをキーにしている箇所を
        // これに置き換えることで、2回勤務の2件が互いを上書きしなくなる。
        pkey: `${name}|${start}`,
        nightShift: isNightShift(startMin, endMin),
        lateShift: isLateShift(startMin, frontOT),
      });
    });

    return { rows: result, logs, dates: Array.from(dateSet).sort(), nameMap };
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
  // resolveName は氏名の表記を月間シフトCSVに合わせる関数〈ver0.5.6で追加〉。
  // 省略した場合は displayName と同じ動作（表記を整えるだけ）になる。
  function parseRookieRows(text, resolveName) {
    const logs = [];
    const raw = parseCSV(text);
    checkHeader(raw, ['氏名', '新人度合い'], 'rookie.csv', logs);

    const resolve = typeof resolveName === 'function' ? resolveName : displayName;
    const dataRows = raw.slice(1);
    const result = [];
    const seenNames = new Set();

    dataRows.forEach((r, i) => {
      const name = resolve(cell(r, 0));
      // 新人度合いは全角数字（１２３）でも受け付ける。〈ver0.5.3〉
      // secret.csvの優先フラグ（normalizeDigits）と扱いをそろえたもの。
      // 小数点も全角（．）を半角に直してから数値化する。
      const degree = parseFloat(normalizeDigits(cell(r, 1)).replace(/．/g, '.'));
      if (!name) return;
      if (isNaN(degree)) {
        logs.push({ level: 'warn', message: `rookie.csv ${i + 2}行目: 新人度合いが数値ではないため読み飛ばしました（${name}）` });
        return;
      }
      // 重複判定は空白を除いた氏名（nameKey）で行う。〈ver0.5.6で変更〉
      // 「山田太郎」と「山田 太郎」は同一人物のため、2行あれば重複として扱う。
      if (seenNames.has(nameKey(name))) {
        logs.push({ level: 'warn', message: `rookie.csv ${i + 2}行目: 「${name}」が複数回記載されています。最初の行のみ使用します。` });
        return;
      }
      seenNames.add(nameKey(name));
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
  // resolveName は氏名の表記を月間シフトCSVに合わせる関数〈ver0.5.6で追加〉。
  // 対象1・対象2の両方に適用する。省略した場合は displayName と同じ動作になる。
  function parseSecretRows(text, seatByNumber, resolveName) {
    const logs = [];
    const raw = parseCSV(text);
    checkHeader(raw, ['種別', '対象1', '対象2', '対象座席', '優先フラグ'], 'secret.csv', logs);

    const resolve = typeof resolveName === 'function' ? resolveName : displayName;
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
      const targetNameForFlag = resolve(cell(r, 1)); // 優先フラグは対象1の氏名に対して適用する
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
        const name1 = resolve(cell(r, 1));
        const name2 = resolve(cell(r, 2));
        if (!name1 || !name2) {
          logs.push({ level: 'warn', message: `secret.csv ${i + 2}行目: 隣接禁止の対象者名が不足しています` });
          return;
        }
        result.push({ type: 'adjacent_forbidden', name1, name2 });
      } else if (type === '禁止席' || type === '固定席' || type === '要サポート') {
        const name = resolve(cell(r, 1));
        const seatCell = cell(r, 3);
        if (!name || !seatCell) {
          logs.push({ level: 'warn', message: `secret.csv ${i + 2}行目: ${type}の情報が不足しています` });
          return;
        }
        const kind = type === '禁止席' ? 'seat_forbidden' : (type === '固定席' ? 'seat_designated' : 'seat_support');
        const seenSet = kind === 'seat_forbidden' ? seenForbidden : (kind === 'seat_designated' ? seenDesignated : seenSupport);
        const dupSet = kind === 'seat_forbidden' ? duplicateForbidden : (kind === 'seat_designated' ? duplicateDesignated : duplicateSupport);
        // 重複判定は空白を除いた氏名（nameKey）で行う。〈ver0.5.6で変更〉
        // 「山田太郎」と「山田 太郎」は同一人物のため、同じ種別に2行あれば重複として扱う。
        // メッセージには利用者が書いた表記をそのまま出すため、集めるのは表示用の氏名。
        const nameK = nameKey(name);
        if (seenSet.has(nameK)) dupSet.add(name);
        seenSet.add(nameK);

        // 半角・全角スペースどちらでも区切りとして認める（同じ行内の重複番号は1つにまとめる）
        const tokens = seatCell.split(/[ \u3000]+/).filter(Boolean);
        const seenNumsInRow = new Set();
        tokens.forEach(rawTok => {
          if (rawTok === '夜勤GL席') {
            if (kind !== 'seat_designated') {
              logs.push({ level: 'warn', message: `secret.csv ${i + 2}行目: 「夜勤GL席」は固定席でのみ指定できます（禁止席・要サポートには指定できません）` });
              return;
            }
            result.push({ type: 'night_gl_designated', name });
            return;
          }
          // 座席番号は全角数字（７）でも受け付ける。〈ver0.5.3〉優先フラグ・新人度合いと
          // 扱いをそろえたもの。メッセージには利用者が書いたままの文字列を出す。
          const tok = normalizeDigits(rawTok);
          if (!/^\d+$/.test(tok)) {
            logs.push({ level: 'warn', message: `secret.csv ${i + 2}行目: 「${rawTok}」は座席番号として認識できません` });
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
  // OJT一人目を空欄にしてOJT二人目のみ入力した場合も、その1名を教官と同席させる
  // 対象者として扱う（OJT一人目の位置に繰り上げて処理する。両方空欄の行のみ読み飛ばす）。
  // 対象座席は「単独配置（教官とOJT一人目のみが同席する場合）」の候補座席を
  // 優先順で指定する。空欄なら既定順（15→12→8→4→3→2→1→他。ver0.4.16で1番まで拡張）。
  // 座席番号を書くとその座席が先頭に来て、残りは既定順のまま続く
  // （例:「12」→12→15→8→4→3→2→1→他）。半角・全角スペースどちらでも区切りとして使える。
  // OJT二人目がいる場合のペア席探索順は、この対象座席から算出する「単独時の順で
  // 12と15のどちらが先に来るか」によって決まる（詳しい組み合わせはalgorithm.js側の
  // OJT_PAIR_* 定数を参照）。ojt.csv自体にペアの座席番号を書く必要はない。
  // resolveName は氏名の表記を月間シフトCSVに合わせる関数〈ver0.5.6で追加〉。
  // 教官名・OJT一人目・OJT二人目のすべてに適用する。省略した場合は
  // displayName と同じ動作になる。
  function parseOjtRows(text, seatByNumber, resolveName) {
    const logs = [];
    const raw = parseCSV(text);
    checkHeader(raw, ['教官名', 'OJT一人目', 'OJT二人目', '対象座席'], 'ojt.csv', logs);

    const resolve = typeof resolveName === 'function' ? resolveName : displayName;
    const dataRows = raw.slice(1);
    const result = [];
    const seenMentors = new Set(); // 教官名（nameKey）
    const duplicateMentors = new Set();
    const traineeOwner = new Map(); // OJT対象者名（nameKey）-> 最初に見つかった教官名（重複検出用）
    const duplicateTrainees = new Set();

    dataRows.forEach((r, i) => {
      const rowLabel = `ojt.csv ${i + 2}行目`;
      const mentorName = resolve(cell(r, 0));
      const ojt1Raw = resolve(cell(r, 1));
      const ojt2Raw = resolve(cell(r, 2));
      const seatCell = cell(r, 3);
      if (!mentorName && !ojt1Raw && !ojt2Raw && !seatCell) return; // 完全な空行

      if (!mentorName) {
        logs.push({ level: 'warn', message: `${rowLabel}: 教官名が空欄のため読み飛ばしました` });
        return;
      }
      if (!ojt1Raw && !ojt2Raw) {
        logs.push({ level: 'warn', message: `${rowLabel}: OJT対象者が入力されていないため読み飛ばしました（${mentorName}）` });
        return;
      }
      // 氏名の突き合わせは空白を除いた氏名（nameKey）で行う。〈ver0.5.6で変更〉
      // 「山田太郎」と「山田 太郎」は同一人物として扱うため。
      if (ojt2Raw && nameKey(ojt2Raw) === nameKey(ojt1Raw)) {
        logs.push({ level: 'warn', message: `${rowLabel}: OJT一人目とOJT二人目に同じ氏名（${ojt1Raw}）が指定されています。読み飛ばしました` });
        return;
      }
      // 教官名とOJT対象者に同じ氏名が書かれている行を弾く。〈ver0.5.3で追加〉
      // 以前はそのまま通していたため、教官とOJT一人目の同席処理で同じ1人が
      // 座席の2枠を占め、画面にも印刷にも同じ人が2回出ていた（二重配置は
      // ver0.4.0で廃止した扱いのため、明らかな入力ミスとして読み飛ばす）。
      if (nameKey(mentorName) === nameKey(ojt1Raw) || nameKey(mentorName) === nameKey(ojt2Raw)) {
        logs.push({ level: 'warn', message: `${rowLabel}: 教官名とOJT対象者に同じ氏名（${mentorName}）が指定されています。読み飛ばしました` });
        return;
      }
      if (seenMentors.has(nameKey(mentorName))) {
        duplicateMentors.add(mentorName);
        logs.push({ level: 'error', message: `ojt.csv: 教官「${mentorName}」が複数行に記載されています。1名につき1行にまとめてください。` });
        return;
      }
      seenMentors.add(nameKey(mentorName));

      // OJT一人目が空欄でOJT二人目のみ入力されている場合も、教官とペア（同席）で
      // 配置できるよう、OJT二人目をOJT一人目の位置に繰り上げて扱う
      // （教官+OJT一人目の同席処理がそのまま使えるようにするため）。
      let ojt1 = ojt1Raw;
      let ojt2 = ojt2Raw;
      if (!ojt1 && ojt2) {
        ojt1 = ojt2Raw;
        ojt2 = '';
      }

      const trainees = [ojt1, ojt2].filter(Boolean);
      trainees.forEach(name => {
        const nameK = nameKey(name);
        if (traineeOwner.has(nameK) && traineeOwner.get(nameK) !== mentorName) {
          duplicateTrainees.add(name);
          logs.push({ level: 'error', message: `ojt.csv: OJT対象者「${name}」が複数の教官（${traineeOwner.get(nameK)}・${mentorName}）に紐づいています。1名の担当教官に統一してください。` });
        }
        traineeOwner.set(nameK, mentorName);
      });

      // 対象座席: 半角・全角スペース区切りで複数指定できる（先頭に来る優先順）
      const seatOrder = [];
      if (seatCell) {
        const tokens = seatCell.split(/[ \u3000]+/).filter(Boolean);
        tokens.forEach(rawTok => {
          // secret.csvの対象座席と同じく、全角数字（７）でも受け付ける。〈ver0.5.3〉
          const tok = normalizeDigits(rawTok);
          if (!/^\d+$/.test(tok)) {
            logs.push({ level: 'warn', message: `${rowLabel}: 「${rawTok}」は座席番号として認識できません` });
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
    parseCSV, timeToMinutes, normalizeTime, normalizeDate, nameKey, displayName,
    parseShiftMonthlyRows, rowsForDate, yearMonthLabelFromDates,
    isNightShift, isLateShift, normalizeOTKind,
    parseRookieRows, parseSecretRows, parseOjtRows,
  };
})();
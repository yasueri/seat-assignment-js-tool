// ============================================================
// ui.js
// 画面の描画、ドラッグ&ドロップ、ファイル入力、配置の保存・読み込み、
// 印刷ページ出力を担当する。
// csv.js と algorithm.js が先に読み込まれている前提。
// ============================================================
(function (NS) {
  "use strict";

  const {
    parseShiftMonthlyRows, rowsForDate, yearMonthLabelFromDates,
    parseRookieRows, parseSecretRows, parseOjtRows, timeToMinutes, isNightShift,
  } = NS.csv;
  const {
    SEATS, seatExists, ADJACENCY, assignSeats, assignLeaderAreas, assignNightLeaders,
    buildSecretIndexes, buildAdjacentGroups, overlaps, isForbiddenPair,
    seatByNumber, numberOfKey, numberOfSeat, buildOjtIndexes, buildRookieIndexes,
    assignSeatsWithEscalation, reshuffleForbiddenAndOthers, ADJACENT_ESCALATION_MAX_LEVEL,
  } = NS.algorithm;

  const WEEKDAY_NAMES = ['日', '月', '火', '水', '木', '金', '土'];
  const LEADER_ROWS = [1, 2], LEADER_COLS = [1, 2, 3];

  // 全探索backtrackを「自動配置を実行」の都度、日勤・夜勤それぞれで走らせる際の設定。
  // ver0.4.11から、隣接禁止の条件を満たせない場合は隣接禁止の優先順位を1段階ずつ
  // 繰り上げて再探索する（assignSeatsWithEscalation。ver0.4.16から上限は
  // 教官・OJTの直後＝段階2まで）。
  // タイムアウトは「1段階あたり」の制限時間で、時間切れの段階があっても次の段階へ進む。
  // 実測では、解が存在するケースは全探索が0.5秒以内に終わる（解が多いほどpoolCapで
  // 早く打ち切られるため速い）。時間がかかるのは「解が存在しない」ケースだけで、
  // その場合は制限時間で打ち切って次の段階へ繰り上げればよいため、ver0.4.17で
  // 10秒→5秒に短縮した（解ありケースに対して10倍以上の余裕がある）。
  //
  // EXHAUSTIVE_POOL_CAP は探索で集める解の上限、EXHAUSTIVE_MAX_SOLUTIONS は
  // 画面の候補として表示する上限。poolCap = maxSolutions + 1 にしておくことで、
  // 「表示しきってもなお解が残っている」状態をalgorithm.js側のhitPoolCapで
  // 正確に判定でき、メッセージの「99通り以上」を厳密に出せる（ver0.4.17）。
  // ver0.4.16まではpoolCapを渡しておらずalgorithm.js側の既定値60に暗黙依存していたため、
  // ui.js側は自分が何件で打ち切られているかを知らなかった。
  const EXHAUSTIVE_MAX_SOLUTIONS = 99;
  const EXHAUSTIVE_POOL_CAP = EXHAUSTIVE_MAX_SOLUTIONS + 1;
  const EXHAUSTIVE_TIME_BUDGET_MS = 5000;
  const EXHAUSTIVE_TIME_BUDGET_SEC = Math.round(EXHAUSTIVE_TIME_BUDGET_MS / 1000);

  // 繰り上げ段階ごとの配置順（メッセージ表示用。algorithm.jsのADJACENT_ESCALATION_MAX_LEVEL
  // 付近のコメントと対応。添字＝段階）
  const ESCALATION_ORDER_LABELS = [
    '優先フラグ → 新人固定席 → 教官・OJT → 固定席 → 要サポート → 隣接禁止 → 禁止席のみの対象者 → その他',
    '優先フラグ → 新人固定席 → 教官・OJT → 固定席 → 隣接禁止 → 要サポート → 禁止席のみの対象者 → その他',
    '優先フラグ → 新人固定席 → 教官・OJT → 隣接禁止 → 固定席 → 要サポート → 禁止席のみの対象者 → その他',
  ];

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
  const rawText = { shift: null, rookie: null, secret: null, ojt: null };
  const appState = {
    seats: initEmptyState(), early: initLeaderState(), late: initLeaderState(),
    overflow: [],
    // nightGL=夜勤GL枠（右側）、nightSpare=見出しなしの予備枠（左側・手書き/一時置き用）
    nightSeats: initEmptyState(), nightGL: initLeaderState(), nightSpare: initLeaderState(),
    nightOverflow: [],
    ruleIndexes: null, adjacentGroupLetters: null,
    currentDateLabel: null, currentDate: null,
    // secret.csvのパース結果（保存ファイルへの書き出しと、読み込み時の
    // ruleIndexes / adjacentGroupLetters の再構築に使う）
    secretRows: null,
    // ojt.csvのパース結果とインデックス（教官・OJTのバッジ再計算・違反チェックに使用。
    // secret.csvと同様、保存ファイルには含めず、読み込み時にojt.csvから作り直す）
    ojtRows: null, ojtIndexes: null,
    // rookie.csvのパース結果とインデックス（新人バッジの再計算に使用。〈ver0.4.19で追加〉
    // ojt.csvと同じ扱いで、rookie.csvが読み込まれていればそちらを優先し、
    // 未読み込みなら保存データが持つ新人バッジをそのまま維持する）
    rookieRows: null, rookieIndexes: null,
    // 全探索backtrackの結果（ver0.4.8で追加）。「自動配置を実行」のたびに作り直す。
    // { feasible, timedOut, totalSolutionsFound, solutions:[...], bestPartial, context, index }
    // 保存データの読み込み時や、隣接禁止対象者が0名などで解が1件しかない場合はnull。
    dayExhaustive: null, nightExhaustive: null,
  };
  let dragSource = null;
  let hasRunOnce = false;
  let editingLoc = null; // 現在手入力編集中のカードの位置（null なら誰も編集していない）
  let shiftMonthly = null; // 月間シフトCSVのパース結果 { rows, logs, dates }

  // 何度も参照するDOM要素はここでまとめて取得しておく
  const els = {
    messages: document.getElementById('messages'),
    calcTime: document.getElementById('calc-time'),
    seatGrid: document.getElementById('seat-grid'),
    overflowList: document.getElementById('overflow-list'),
    overflowAppend: document.getElementById('overflow-append'),
    dateSelect: document.getElementById('date-select'),
    yearMonthLabel: document.getElementById('year-month-label'),
    dayDateLabel: document.getElementById('day-date-label'),
    nightDateLabel: document.getElementById('night-date-label'),
    earlyGrid: document.getElementById('early-grid'),
    lateGrid: document.getElementById('late-grid'),
    nightSeatGrid: document.getElementById('night-seat-grid'),
    nightGlGrid: document.getElementById('night-gl-grid'),
    nightSpareGrid: document.getElementById('night-spare-grid'),
    nightOverflowList: document.getElementById('night-overflow-list'),
    nightOverflowAppend: document.getElementById('night-overflow-append'),
  };
  // 全探索backtrackの「候補」パネル（日勤・夜勤それぞれ）
  const candidateEls = {
    day: {
      inner: document.getElementById('day-candidate-inner'),
      count: document.getElementById('day-candidate-count'),
      note: document.getElementById('day-candidate-note'),
      btnNext: document.getElementById('day-btn-next-pattern'),
      btnBest: document.getElementById('day-btn-best-pattern'),
      btnShuffle: document.getElementById('day-btn-shuffle-others'),
    },
    night: {
      inner: document.getElementById('night-candidate-inner'),
      count: document.getElementById('night-candidate-count'),
      note: document.getElementById('night-candidate-note'),
      btnBest: document.getElementById('night-btn-best-pattern'),
      btnNext: document.getElementById('night-btn-next-pattern'),
      btnShuffle: document.getElementById('night-btn-shuffle-others'),
    },
  };
  // overflow-append は再描画のたびに作り直される要素ではないため、
  // ドロップ受付は最初に1回だけ登録する（毎回登録するとリスナーが積み重なってしまう）
  makeDropTarget(els.overflowAppend, { type: 'overflow-append' });
  makeDropTarget(els.nightOverflowAppend, { type: 'night-overflow-append' });

  function initEmptyState() {
    const seats = {};
    for (const s of SEATS) seats[s.key] = [null, null];
    return seats;
  }

  // 早番・遅番エリア・夜勤GL枠用（2行×3列、1枠1名）
  function initLeaderState() {
    const s = {};
    LEADER_ROWS.forEach(r => LEADER_COLS.forEach(c => { s[`${r}-${c}`] = null; }));
    return s;
  }

  // ---------- あふれ欄の組み立て ----------

  // 人物の識別子。同日2回勤務の2件を区別するため、氏名ではなくpkey（氏名|開始時刻）で
  // 判定する。古い保存ファイル由来などでpkeyが無い場合に備えて同じ形で補完する。
  function personKey(p) {
    return p.pkey || `${p.name}|${p.start}`;
  }

  // 「自動配置を実行した時点でのこの人」を指す識別子。〈ver0.5.3で追加〉
  // ✎編集で氏名・開始時刻を変えてもこの値は変わらないため、次案・シャッフルで
  // 座席表を作り直すときに、作り直しの元になった人物と、いま画面にあるカードとを
  // 対応づけられる（originPkeyは✎編集の保存時にだけ付く。それ以外はpkeyと同じ）。
  function originKey(p) { return p.originPkey || personKey(p); }

  // いま画面のどこに誰がいるかを originKey で引ける形にまとめる。
  // 値はカードの現物（✎編集後の内容を含む）と、その居場所のappStateキー。
  function collectCurrentPeople() {
    const map = new Map();
    const put = (p, area) => { if (p && !map.has(originKey(p))) map.set(originKey(p), { person: p, area }); };
    for (const s of SEATS) {
      appState.seats[s.key].forEach(p => put(p, 'seats'));
      appState.nightSeats[s.key].forEach(p => put(p, 'nightSeats'));
    }
    ['early', 'late', 'nightGL', 'nightSpare'].forEach(area => {
      Object.keys(appState[area]).forEach(k => put(appState[area][k], area));
    });
    (appState.overflow || []).forEach(p => put(p, 'overflow'));
    (appState.nightOverflow || []).forEach(p => put(p, 'nightOverflow'));
    return map;
  }

  // 作り直した座席表・あふれ欄に入っている1人分を、いまの画面の状態に合わせる。
  // 〈ver0.5.3で追加〉座席表の作り直しは「自動配置を実行した時点の人物一覧」
  // （ex.context.people）から行うため、そのままでは次の3つのずれが起きる。
  //   ・✎削除した人が復活する
  //   ・早番・遅番エリアや夜勤側へ手で移した人が、座席にも現れて二重表示になる
  //   ・✎編集で直した氏名・時刻が、編集前の内容に戻る
  // いま画面にいなければ削除された人、作り直さないエリアにいれば移された人として
  // 取り除き、残る人は画面にある最新のカードで置き換える。
  function reconcileRebuilt(person, current, seatsKey, overflowKey) {
    if (!person) return null;
    const cur = current.get(originKey(person));
    if (!cur) return null;                                              // 画面から消えている＝✎削除された
    if (cur.area !== seatsKey && cur.area !== overflowKey) return null; // 別のエリアへ手で移されている
    return cur.person;                                                  // ✎編集後の最新の内容を使う
  }

  // 作り直した座席表（15席×2枠）を、上のreconcileRebuiltで1枠ずつ調整する。
  function reconcileRebuiltState(newState, current, seatsKey, overflowKey) {
    const out = {};
    for (const s of SEATS) {
      out[s.key] = (newState[s.key] || [null, null])
        .map(p => reconcileRebuilt(p, current, seatsKey, overflowKey));
    }
    return out;
  }

  // 「次案を表示」「候補1に戻す」「一部シャッフル」で座席表を作り直すときの、
  // あふれ欄の組み立て。〈ver0.5.2で追加〉
  //
  // 座席1〜15の計算対象は日勤＝OPのみ、夜勤＝OP＋座席側に回った役席・GLのみで、
  // 早番・遅番エリアや夜勤GL枠の人は含まれていない。そのため座席側の計算結果
  // （reshuffled.overflow）だけであふれ欄を上書きすると、計算に渡していない人が
  // 画面のどこにも残らず、その日の配置から抜け落ちる。
  // そこで、いまあふれ欄と座席1〜15にいる人のうち、座席計算の対象
  // （ex.context.people）に含まれない人を拾って引き継ぐ。
  // ・早番・遅番エリア・夜勤GL枠・予備枠は走査しない。これらの枠は作り直されず
  //   画面に残るため、拾うとあふれ欄と二重に表示されてしまう。
  // ・座席1〜15にいる人は走査する。座席表そのものが作り直されて席から消えるため、
  //   座席計算の対象外であればあふれ欄へ戻すのが正しい動作。
  // ・日勤側の操作では夜勤側（およびその逆）は走査しない。反対側の枠はそのまま
  //   画面に残るため、拾う必要がない。
  //
  // ※ appState[seatsKey] を新しい座席表で差し替える前に呼ぶこと
  //    （差し替え後だと、引き継ぐべき人が座席表から消えている）。
  function rebuildOverflowList(ex, seatOverflow, seatsKey, overflowKey, current) {
    const context = ex && ex.context;
    const people = context && Array.isArray(context.people) ? context.people : null;
    // 座席計算の対象者そのものが取れない場合は、座席にいる全員が「対象外」と判定されて
    // あふれ欄へ流れ込んでしまうため、引き継ぎを行わない（従来どおりの動作にする）。
    // 〈ver0.5.3〉ここは「取れない（null）」と「0名（空の配列）」を区別すること。
    // その日の夜勤が0名という状況は普通に起こりえて、そのとき夜勤座席にいるのは
    // 手で置いた人だけになる。0名を取れない扱いにすると、その人たちを引き継がないまま
    // 座席表が空で作り直され、画面から消えてしまう。
    if (!people) return (seatOverflow || []).filter(Boolean);
    const seatPeople = new Set(people.map(personKey));

    // 座席側の計算であふれた人も、削除・移動・✎編集を反映させてから並べる〈ver0.5.3〉
    const merged = (seatOverflow || [])
      .map(p => reconcileRebuilt(p, current, seatsKey, overflowKey))
      .filter(Boolean);
    const seen = new Set(merged.map(originKey));
    const candidates = (appState[overflowKey] || []).filter(Boolean);
    for (const s of SEATS) {
      for (let i = 0; i < 2; i++) {
        const p = appState[seatsKey][s.key][i];
        if (p) candidates.push(p);
      }
    }
    for (const p of candidates) {
      const k = originKey(p);
      if (seatPeople.has(k) || seen.has(k)) continue;
      seen.add(k);
      merged.push(p);
    }
    return merged;
  }

  // ---------- ファイル読み込み ----------
  const fileStatusEls = {
    shift: document.getElementById('status-shift'),
    rookie: document.getElementById('status-rookie'),
    secret: document.getElementById('status-secret'),
    ojt: document.getElementById('status-ojt'),
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
      // secret.csvを（再)読み込みしたとき、既に配置が存在する場合は
      // 違反チェック用のルール（ruleIndexes）と、配置済みカードのバッジ表示を
      // その場で再構築する。これにより、保存した配置を読み込んだ後に
      // secret.csvを読み込む、という順序でも違反チェックとバッジが有効になる。
      if (key === 'secret' && hasRunOnce) refreshRuleIndexesFromSecret();
      // ojt.csvも同様に、既に配置が存在する場合はその場でバッジ表示を再構築する
      if (key === 'ojt' && hasRunOnce) refreshOjtIndexesFromOjt();
      // rookie.csvも同様（ver0.4.19）
      if (key === 'rookie' && hasRunOnce) refreshRookieIndexesFromRookie();
    } catch (e) {
      markFileFailed(key);
      if (key === 'shift') { shiftMonthly = null; populateDateSelect(null); }
    }
  }

  // 現在読み込まれているsecret.csv（rawText.secret）から、違反チェック用の
  // ruleIndexes / adjacentGroupLetters を作り直し、配置済みカードのバッジ表示も
  // 再計算して画面を更新する。secret.csvが未読み込みの場合は何もしない
  // （呼び出し側でrawText.secretの有無を見て呼ぶこと）。
  function refreshRuleIndexesFromSecret() {
    const secretParsed = parseSecretRows(rawText.secret, seatByNumber);
    appState.secretRows = secretParsed.rows;
    appState.ruleIndexes = buildSecretIndexes(secretParsed.rows);
    appState.adjacentGroupLetters = buildAdjacentGroups(secretParsed.rows);
    // 全探索backtrackの候補は旧secret.csvの内容で計算済みのため、ここでは無効化する
    // （「次案を表示」「一部シャッフル」ボタンを押すと矛盾した内容になってしまうため）
    appState.dayExhaustive = null;
    appState.nightExhaustive = null;
    reapplyBadges();
    render();
    renderMessages([
      ...secretParsed.logs,
      { level: 'info', message: 'secret.csvを読み込み、違反チェック用のルールとバッジ表示を更新しました。' },
    ]);
    scrollToMessages();
  }

  // secret.csvと同様、現在読み込まれているojt.csv（rawText.ojt）から
  // ojtIndexesを作り直し、配置済みカードの教官・OJTバッジ表示を再計算する。
  // ※座席そのものの再配置は行わない（既存の配置を崩さないため）。
  function refreshOjtIndexesFromOjt() {
    const ojtParsed = parseOjtRows(rawText.ojt, seatByNumber);
    appState.ojtRows = ojtParsed.rows;
    appState.ojtIndexes = buildOjtIndexes(ojtParsed.rows);
    // secret.csvと同様、全探索backtrackの候補は旧ojt.csvの内容で計算済みのため無効化する。
    // 〈ver0.5.2〉候補を残したままだと、「次案を表示」「一部シャッフル」が自動配置を
    // 実行した時点の人物データから座席表を作り直すため、いま付け直したバッジが
    // 読み込み前の内容に戻ってしまう。
    appState.dayExhaustive = null;
    appState.nightExhaustive = null;
    reapplyBadges();
    render();
    renderMessages([
      ...ojtParsed.logs,
      { level: 'info', message: 'ojt.csvを読み込み、教官・OJTのバッジ表示を更新しました（既存の座席配置は変更していません。反映するには自動配置をやり直してください）。' },
    ]);
    scrollToMessages();
  }
  // rookie.csvも同様（ver0.4.19）。読み込んだ時点で新人バッジを付け直す。
  // ※座席そのものの再配置は行わない（既存の配置を崩さないため）。
  function refreshRookieIndexesFromRookie() {
    const rookieParsed = parseRookieRows(rawText.rookie);
    appState.rookieRows = rookieParsed.rows;
    appState.rookieIndexes = buildRookieIndexes(rookieParsed.rows);
    // ojt.csvと同じ理由で候補を無効化する〈ver0.5.2〉
    appState.dayExhaustive = null;
    appState.nightExhaustive = null;
    reapplyBadges();
    render();
    renderMessages([
      ...rookieParsed.logs,
      { level: 'info', message: 'rookie.csvを読み込み、新人のバッジ表示を更新しました（既存の座席配置は変更していません。反映するには自動配置をやり直してください）。' },
    ]);
    scrollToMessages();
  }


  // 月間シフトCSVを読み込み直すたびに呼び、日付セレクタを更新する
  function refreshShiftMonthly() {
    shiftMonthly = parseShiftMonthlyRows(rawText.shift);
    populateDateSelect(shiftMonthly);
    // 使える行が1件も無い場合、配置対象日を選べず「自動配置を実行」まで進めないため、
    // 解析時に作られた行ごとの警告が画面に出る機会そのものが無くなってしまう。
    // 〈ver0.5.3で追加〉原因が分かるよう、読み込んだ時点でメッセージ欄に出す。
    // 1件でも使える行があれば、警告は従来どおり「自動配置を実行」時にまとめて表示する。
    if (shiftMonthly.dates.length === 0) {
      renderMessages([
        {
          level: 'error',
          message: '月間シフトCSVから、配置に使える行を1件も読み取れませんでした。列の並び（日付, 氏名, 開始時刻, 終了時刻, 前残業, 後残業, 役割）と、下記の内容をご確認ください。',
        },
        ...shiftMonthly.logs,
      ]);
      scrollToMessages();
    }
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
      updateRunButtonState();
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
    updateRunButtonState();
  }

  // 「自動配置を実行」ボタンは、配置対象日が選ばれるまでグレーアウトしておく
  function updateRunButtonState() {
    const btnRun = document.getElementById('btn-run');
    btnRun.disabled = !els.dateSelect.value;
  }
  els.dateSelect.addEventListener('change', updateRunButtonState);

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
  setupFileInput('file-ojt', 'ojt');

  // ---------- CSVファイルのまとめてドラッグ&ドロップ ----------
  // ファイル名に含まれる文字列から、shift/rookie/secret/ojtのどれに該当するかを判定する
  function classifyFileName(filename) {
    const lower = filename.toLowerCase();
    if (lower.includes('shift')) return 'shift';
    if (lower.includes('rookie')) return 'rookie';
    if (lower.includes('secret')) return 'secret';
    if (lower.includes('ojt')) return 'ojt';
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
      alert(`ファイル名から種類を判別できませんでした: ${unmatched.join(', ')}\nファイル名に shift / rookie / secret / ojt のいずれかを含めてください。`);
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

  // 抽出した1日分の行を、以下の4つに振り分ける。
  //   opRows          … 日勤座席グリッド用（OPかつ夜勤でない。教官・OJTで座席側に
  //                     回る役席・GLもここに含める）
  //   leaderRows      … 早番・遅番エリア用（役席・GLかつ夜勤でない。教官・OJTで
  //                     座席側に回る人は除く）
  //   nightOpRows     … 夜勤座席グリッド用（OPかつ夜勤）
  //   nightLeaderRows … 夜勤の役席・GL（配置先はassignNightLeadersが決める:
  //                     1名は夜勤GL枠2行1列目、2人目は座席10、3人目以降は空席へ）
  // 夜勤＝開始時刻が22:00より遅い、または終了時刻が26:00より遅いスタッフ（csv.jsで判定済み）。
  //
  // ojtIndexes（教官・OJT。ojt.csv未読み込みならnull）: 教官の通常の役割が
  // 役席・GLの場合、その日出勤しているOJT対象者を担当しているならば、
  // 早番・遅番エリアではなく座席グリッド側（opRows）に回す。実際の教官・OJTの
  // 同席処理そのものはassignSeats内（algorithm.js）で行う。夜勤は対象外
  // （夜勤のOJTは既存の固定席運用で対応するため、ここでは分岐を作らない）。
  function splitDayRows(dayRows, ojtIndexes) {
    const opRows = [];
    const leaderRows = [];
    const nightOpRows = [];
    const nightLeaderRows = [];
    // 教官を座席グリッド側（opRows）へ回すかどうかの判定に使う、
    // 「本日、日勤の座席1〜15に並ぶ人」の氏名。
    // 〈ver0.5.3で変更〉以前はその日出勤している全員を対象にしていたため、
    // OJT対象者が夜勤だった場合や役席・GLだった場合にも教官が座席側へ移されていた。
    // それらの対象者は日勤の座席1〜15に来ないため同席は成立せず、教官が
    // 早番・遅番エリアから抜けてしまうだけだった。
    const dayOpNames = new Set(
      dayRows.filter(r => !r.nightShift && r.role === 'OP').map(r => r.name)
    );
    const isMentorWithPresentTrainee = (name) => {
      if (!ojtIndexes || !ojtIndexes.traineesOf.has(name)) return false;
      return ojtIndexes.traineesOf.get(name).some(t => dayOpNames.has(t));
    };
    dayRows.forEach(r => {
      const base = {
        name: r.name, start: r.start, end: r.end, startMin: r.startMin, endMin: r.endMin,
        // 同日2回勤務を区別する識別子（csv.jsが付与）。〈ver0.4.18〉
        pkey: r.pkey || `${r.name}|${r.start}`,
        frontOT: r.frontOT, backOT: r.backOT,
      };
      if (r.nightShift) {
        if (r.role === 'OP') {
          nightOpRows.push(base);
        } else {
          nightLeaderRows.push({ ...base, role: r.role });
        }
      } else if (r.role === 'OP') {
        opRows.push(base);
      } else if (isMentorWithPresentTrainee(r.name)) {
        opRows.push({ ...base, role: r.role });
      } else {
        leaderRows.push({ ...base, role: r.role, isLate: r.lateShift });
      }
    });
    return { opRows, leaderRows, nightOpRows, nightLeaderRows };
  }

  // ---------- 自動配置の実行 ----------
  // 全探索backtrack（＋繰り上げ再探索）の結果から、従来の assignSeats と同じ形
  // （{state, overflow, logs}）を作る。解けた場合はスコア最上位の解を採用し、
  // どの段階でも解けなかった場合は greedyFallback()
  // （＝従来の貪欲+MRV assignSeats）の結果を使う。どちらの場合も、状況を allLogs に積む。
  // labelPrefix: '日勤' | '夜勤'（メッセージの見出し用）
  function buildSeatResultFromExhaustive(exhaustiveResult, labelPrefix, greedyFallback, allLogs) {
    if (exhaustiveResult.feasible && exhaustiveResult.solutions.length > 0) {
      const level = exhaustiveResult.escalationLevel || 0;
      // 繰り上げが発動した場合は、通常の優先順位では解けなかったこと・今回の配置順・
      // 後回しになったルールの指定どおりに配置できていない可能性があることを知らせる
      if (level > 0) {
        allLogs.push({
          level: 'warn', showDialog: true,
          message: `【${labelPrefix}】通常の優先順位では隣接禁止の条件を満たす配置が見つからなかったため、隣接禁止の優先順位を${level}段階繰り上げて配置しました（今回の配置順: ${ESCALATION_ORDER_LABELS[level] || ESCALATION_ORDER_LABELS[ESCALATION_ORDER_LABELS.length - 1]}）。繰り上げにより後回しになったルール（固定席・要サポート等）の指定どおりに配置できていない方がいる可能性があるため、メッセージと座席表をご確認ください。`,
        });
      }
      const best = exhaustiveResult.solutions[0];
      // 探索がどう終わったかを、実際の結果に即して3通りに出し分ける（ver0.4.17）。
      //   1) hitPoolCap: 表示上限（EXHAUSTIVE_MAX_SOLUTIONS件）を超えて解が見つかった
      //      → 正確な総数は分からないため「○通り以上」
      //   2) timedOut:   制限時間で探索を打ち切った → 「○通り見つけたところで制限時間」
      //   3) それ以外:   探索し尽くした → 確定した件数をそのまま「○通り」
      let foundPhrase;
      if (exhaustiveResult.hitPoolCap) {
        foundPhrase = `実行可能な配置を${EXHAUSTIVE_MAX_SOLUTIONS}通り以上見つけました`;
      } else if (exhaustiveResult.timedOut) {
        foundPhrase = `実行可能な配置を${exhaustiveResult.totalSolutionsFound}通り見つけたところで、探索の制限時間（${EXHAUSTIVE_TIME_BUDGET_SEC}秒）になりました`;
      } else {
        foundPhrase = `実行可能な配置を${exhaustiveResult.totalSolutionsFound}通り見つけました`;
      }
      // 実行可能な配置が1通りしかない場合（隣接禁止側の案を切り替える余地がない場合）は
      // 「次案を表示」を案内せず、「一部シャッフル」（禁止席のみの対象者・その他側は
      // ランダムに配置し直せる）のみ案内する
      const onlyOneSolution = exhaustiveResult.solutions.length <= 1;
      const message = onlyOneSolution
        ? `【${labelPrefix}】隣接禁止対象者について全探索を行い、${foundPhrase}。（「一部シャッフル」ボタンで禁止席対象者・その他スタッフの配置を変更できます）。`
        : `【${labelPrefix}】隣接禁止対象者について全探索を行い、${foundPhrase}。最も良さそうな案を採用しています（「次案を表示」ボタンで他の案に切り替えられます）。`;
      allLogs.push({ level: 'info', message });
      return { state: best.state, overflow: best.overflow, logs: best.logs };
    }
    // どの段階でも解けなかった場合（証明つきで解なし、またはタイムアウト）は
    // 従来の貪欲+MRVにフォールバックする
    const attempts = exhaustiveResult.attempts || [];
    const timedOutAny = attempts.some(a => a.timedOut) || exhaustiveResult.timedOut;
    const timeoutNote = timedOutAny
      ? `（一部の段階は制限時間${EXHAUSTIVE_TIME_BUDGET_SEC}秒で探索を打ち切ったため、「本当に解なし」と証明できたわけではありません）`
      : '';
    const partialNote = exhaustiveResult.bestPartial
      ? `最も惜しい組み合わせでも配置できなかった対象者: ${exhaustiveResult.bestPartial.unplacedNames.join('、')}さん。`
      : '';
    allLogs.push({
      level: 'warn', showDialog: true,
      message: `【${labelPrefix}】隣接禁止の優先順位を教官・OJTの直後（段階${ADJACENT_ESCALATION_MAX_LEVEL}）まで繰り上げて探索しても、隣接禁止対象者全員を配置できる組み合わせが見つかりませんでした${timeoutNote}。${partialNote}通常の配置方法（貪欲法。教官・OJTの直後に隣接禁止を配置する順序）で処理します。secret.csvの条件を確認してください。`,
    });
    return greedyFallback();
  }

  document.getElementById('btn-run').addEventListener('click', () => {
    if (!rawText.shift) {
      alert('月間シフトCSVを選択してください。');
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

    // rookie.csv / secret.csv / ojt.csv はいずれも必須ではない。未読み込みの場合は
    // 該当する処理（新人固定席・固定席や禁止席・隣接禁止のチェック・教官とOJT・要サポート）を
    // 丸ごとスキップし、通常配置のみを行う
    const rookieParsed = rawText.rookie ? parseRookieRows(rawText.rookie) : { rows: [], logs: [] };
    const secretParsed = rawText.secret
      ? parseSecretRows(rawText.secret, seatByNumber)
      : { rows: [], logs: [], duplicateDesignatedNames: [], duplicateForbiddenNames: [], duplicateSupportNames: [] };
    const ojtParsed = rawText.ojt
      ? parseOjtRows(rawText.ojt, seatByNumber)
      : { rows: [], logs: [], duplicateMentorNames: [], duplicateTraineeNames: [] };
    const ojtIndexes = buildOjtIndexes(ojtParsed.rows);
    const dayRows = rowsForDate(shiftMonthly.rows, selectedDate);
    const { opRows, leaderRows, nightOpRows, nightLeaderRows } = splitDayRows(dayRows, ojtIndexes);

    const allLogs = [...shiftMonthly.logs, ...rookieParsed.logs, ...secretParsed.logs, ...ojtParsed.logs];
    if (!rawText.rookie) allLogs.push({ level: 'info', message: 'rookie.csvが読み込まれていないため、新人固定席は使用せず配置しました。' });
    if (!rawText.secret) allLogs.push({ level: 'info', message: 'secret.csvが読み込まれていないため、固定席・禁止席・隣接禁止・要サポート・優先フラグのルールは使用せず配置しました。' });

    // 固定席・禁止席・要サポートで同じ人が複数行に分かれている場合や、ojt.csvで教官の重複・
    // OJT対象者の担当教官重複がある場合は、配置を実行せずに知らせる
    // （複数の座席は1行にまとめてスペース区切りで指定する仕様のため）
    const secretDuplicateMessage = (kind, name) =>
      `secret.csv: 「${name}」さんが「${kind}」に複数行あります。1人1行にまとめ、複数の座席は半角または全角スペース区切りで指定してください。`;
    const dupMessages = [
      ...(secretParsed.duplicateDesignatedNames || []).map(name => ({ level: 'error', message: secretDuplicateMessage('固定席', name) })),
      ...(secretParsed.duplicateForbiddenNames || []).map(name => ({ level: 'error', message: secretDuplicateMessage('禁止席', name) })),
      ...(secretParsed.duplicateSupportNames || []).map(name => ({ level: 'error', message: secretDuplicateMessage('要サポート', name) })),
    ];
    // ojt.csv側の重複（教官の重複・OJT対象者の担当重複）は、csv.jsが解析時に
    // 同じ内容のエラーを既にlogsへ積んでいる。〈ver0.5.3〉ここで作り直すと同じ問題が
    // 2件あるように見えるため、メッセージは作らず「配置を止めるか」の判定にだけ使う。
    const ojtDuplicateCount = (ojtParsed.duplicateMentorNames || []).length
      + (ojtParsed.duplicateTraineeNames || []).length;
    if (dupMessages.length > 0 || ojtDuplicateCount > 0) {
      renderMessages([...allLogs, ...dupMessages]);
      scrollToMessages();
      return; // CSVを修正してもらうため、配置は実行しない
    }

    if (hasRunOnce) {
      const ok = confirm('手動で調整した内容は失われます。自動配置をやり直しますか？');
      if (!ok) return;
    }

    // 計算時間の計測開始（実際の配置計算のみを対象とし、CSVパースやバリデーションは含めない）
    const calcStartTime = performance.now();

    // --- 日勤 ---
    // 教官・OJT（新人固定席の次・固定席より前の優先順位）は assignSeats / assignSeatsWithEscalation 内で処理する。
    // 隣接禁止対象者の配置は、まず全探索backtrackで解けるかどうかを試す。
    // ver0.4.11から、通常の優先順位（段階0）で解けない場合は隣接禁止の優先順位を
    // 1段階ずつ繰り上げて再探索する（教官・OJTの直後＝段階2まで。優先フラグ・
    // 新人固定席・教官・OJTは常に先のまま）。いずれかの段階で解けた場合はその最良解（スコア最上位）を
    // 採用し、どの段階でも解けなかった場合のみ、従来の貪欲+MRV（assignSeats）に
    // フォールバックする。
    const dayExhaustiveResult = assignSeatsWithEscalation(opRows, rookieParsed.rows, secretParsed.rows, {
      ojtRows: ojtParsed.rows, maxSolutions: EXHAUSTIVE_MAX_SOLUTIONS,
      poolCap: EXHAUSTIVE_POOL_CAP, timeBudgetMs: EXHAUSTIVE_TIME_BUDGET_MS,
    });
    const seatResult = buildSeatResultFromExhaustive(
      dayExhaustiveResult, '日勤',
      // どの段階でも解けなかった場合の最終フォールバック。ver0.4.13から、
      // 最終段階（教官・OJTの直後に隣接禁止）の優先順位で貪欲配置する
      // （繰り上げの最終段階を尊重するため。ADJACENT_ESCALATION_MAX_LEVEL参照）
      () => assignSeats(opRows, rookieParsed.rows, secretParsed.rows,
        { ojtRows: ojtParsed.rows, adjacentEscalationLevel: ADJACENT_ESCALATION_MAX_LEVEL }),
      allLogs,
    );
    appState.dayExhaustive = (dayExhaustiveResult.feasible && dayExhaustiveResult.solutions.length > 0)
      ? { ...dayExhaustiveResult, index: 0 }
      : null;
    const leaderResult = assignLeaderAreas(leaderRows);

    // --- 夜勤 ---
    // 1) 役席・GLの行き先を決める（1名はGL枠2行1列目。2人目は座席10、3人目以降は空席へ。
    //    GL枠の優先候補は secret.csv の 固定席「夜勤GL席」から取得する）
    const secretIndexes = buildSecretIndexes(secretParsed.rows);
    const nightLeaderResult = assignNightLeaders(nightLeaderRows, secretIndexes.nightGLDesignatedNames);
    // 2) 座席側に回るリーダー（2人目以降）をOPと合流させる。2人目には座席10の
    //    固定席ルールをこの配置限定で追加する（secret.csv自体は変更しない）。
    //    silent:true を付けることで、座席への強制配置は行いつつ「固定席」
    //    バッジは表示しない（secret.csvに入力された指定ではないため）
    const nightSeatRows = [...nightOpRows, ...nightLeaderResult.seatLeaders];
    let nightSecretRows = secretParsed.rows;
    if (nightLeaderResult.seat10Name) {
      const seat10 = seatByNumber(10);
      nightSecretRows = [...secretParsed.rows,
        { type: 'seat_designated', name: nightLeaderResult.seat10Name, row: seat10.row, col: seat10.col, silent: true }];
    }
    // 3) 新人固定席 ＞ 教官・OJT ＞ 固定席（座席10のリーダー含む）＞ 時刻順 で配置。
    //    nightContext:true により、同列隣接をソフトに回避する（固定席で結果的に
    //    隣接するのは許容）。座席側に回った「夜勤GL席」指定者にはバッジが付く。
    //    夜勤は教官・OJTの役席・GL振り替え（splitDayRows側の分岐）は行わないが、
    //    OP同士の教官・OJTペア自体はここでも同じロジックが動く（実害はない前提）。
    //    隣接禁止対象者の配置は日勤と同様、まず全探索backtrackを試し、
    //    解けない場合は隣接禁止の優先順位を繰り上げて再探索する（ver0.4.11）。
    const nightExhaustiveOptions = {
      nightContext: true, ojtRows: ojtParsed.rows, maxSolutions: EXHAUSTIVE_MAX_SOLUTIONS,
      poolCap: EXHAUSTIVE_POOL_CAP, timeBudgetMs: EXHAUSTIVE_TIME_BUDGET_MS,
    };
    const nightExhaustiveResult = assignSeatsWithEscalation(nightSeatRows, rookieParsed.rows, nightSecretRows, nightExhaustiveOptions);
    const nightResult = buildSeatResultFromExhaustive(
      nightExhaustiveResult, '夜勤',
      // 日勤と同様、最終フォールバックは最終段階の優先順位で貪欲配置する
      () => assignSeats(nightSeatRows, rookieParsed.rows, nightSecretRows,
        { nightContext: true, ojtRows: ojtParsed.rows, adjacentEscalationLevel: ADJACENT_ESCALATION_MAX_LEVEL }),
      allLogs,
    );
    appState.nightExhaustive = (nightExhaustiveResult.feasible && nightExhaustiveResult.solutions.length > 0)
      ? { ...nightExhaustiveResult, index: 0 }
      : null;

    // どちらの配置に関するメッセージか分かるように接頭辞を付ける
    const prefixLogs = (logs, prefix) => logs.map(l => ({ ...l, message: `${prefix}${l.message}` }));
    allLogs.push(
      ...prefixLogs([...seatResult.logs, ...leaderResult.logs], '【日勤】'),
      ...prefixLogs([...nightLeaderResult.logs, ...nightResult.logs], '【夜勤】'),
    );

    appState.seats = seatResult.state;
    appState.early = leaderResult.early;
    appState.late = leaderResult.late;
    // 早番・遅番エリアの6名を超えた役席・GL（leaderResult.overflow）も、
    // 座席1〜15のあふれ（seatResult.overflow）と同じ「あふれ」欄に合流させる
    appState.overflow = [...seatResult.overflow, ...leaderResult.overflow];
    appState.nightSeats = nightResult.state;
    appState.nightGL = nightLeaderResult.glState;
    appState.nightSpare = initLeaderState(); // 予備枠（左側）は自動配置では使わない
    appState.nightOverflow = nightResult.overflow;
    appState.ruleIndexes = buildSecretIndexes(secretParsed.rows);
    appState.adjacentGroupLetters = buildAdjacentGroups(secretParsed.rows);
    appState.secretRows = secretParsed.rows;
    appState.ojtRows = ojtParsed.rows;
    appState.ojtIndexes = ojtIndexes;
    appState.rookieRows = rookieParsed.rows;
    appState.rookieIndexes = buildRookieIndexes(rookieParsed.rows);
    appState.currentDateLabel = formatDateLabel(selectedDate);
    appState.currentDate = selectedDate;
    hasRunOnce = true;
    editingLoc = null;

    // 計算時間の計測終了。「自動配置を実行」ボタンの右側に表示する。
    const calcElapsedMs = Math.round(performance.now() - calcStartTime);
    els.calcTime.textContent = `計算時間：${calcElapsedMs}ms`;

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
    if (a.type === 'seat' || a.type === 'nightSeat') return a.seatKey === b.seatKey && a.slotIndex === b.slotIndex;
    if (a.type === 'early' || a.type === 'late' || a.type === 'nightGL' || a.type === 'nightSpare') return a.key === b.key;
    if (a.type === 'overflow' || a.type === 'nightOverflow') return a.index === b.index;
    return false;
  }

  // 氏名を手入力で変更したとき、secret.csvのルール（固定席・禁止席・隣接禁止・要サポート）を
  // 新しい氏名で判定し直してバッジ用の情報を作る（新人バッジは対象外。自動配置時の
  // 優先度に基づくもので、手入力の変更で再判定する性質のものではないため）。
  // existing（省略可）: 教官・OJTバッジをojt.csv未読み込み時に維持するための、
  // 変更前の人物オブジェクト。deriveOjtBadgeFields参照。
  function deriveBadgeFields(name, existing) {
    const idx = appState.ruleIndexes;
    if (!idx) {
      return {
        hasAdjacentRule: false, hasForbiddenSeatRule: false, isDesignated: false,
        designatedSeatNumbers: [], forbiddenSeatNumbers: [], adjacentGroupLetter: null,
        isSupport: false, supportSeatNumbers: [], hasPriorityFlag: false,
        ...deriveOjtBadgeFields(name, existing),
        ...deriveRookieBadgeFields(name, existing),
      };
    }
    const letters = appState.adjacentGroupLetters;
    return {
      hasAdjacentRule: idx.adjacentRuleNames.has(name),
      hasForbiddenSeatRule: idx.forbiddenSeatRuleNames.has(name),
      isDesignated: idx.designatedNames.has(name),
      designatedSeatNumbers: (idx.designatedSeatsMap.get(name) || []).map(numberOfKey),
      forbiddenSeatNumbers: (idx.forbiddenSeatsMap.get(name) || []).map(numberOfKey),
      adjacentGroupLetter: (letters && letters.get(name)) || null,
      isSupport: idx.supportNames.has(name),
      supportSeatNumbers: (idx.supportSeatsMap.get(name) || []).map(numberOfKey),
      hasPriorityFlag: idx.priorityFlagMap.has(name),
      ...deriveOjtBadgeFields(name, existing),
      ...deriveRookieBadgeFields(name, existing),
    };
  }

  // ojt.csv（教官・OJT）由来のバッジ情報を、現在のappState.ojtIndexesから作る。
  // ojt.csvが読み込まれている場合は、常にそこから最新の状態を計算する
  // （氏名を手入力で変更した場合の再判定や、ojt.csv再読み込み時の更新はこちら）。
  // ojt.csvが未読み込みの場合、existing（変更前の人物オブジェクト）が渡されていれば
  // その教官・OJTバッジ情報をそのまま維持する（ver0.4.14。保存データの読み込み時に、
  // 保存ファイル自身が持つ教官・OJT情報を消してしまわないようにするため。新人固定席の
  // isRookie/rookieRankと同様の扱い）。existingが渡されていない場合（氏名を手入力で
  // 変更した直後など）はfalse/nullにする。
  // rookie.csv（新人固定席）由来のバッジ情報。〈ver0.4.19で追加〉
  // 教官・OJT（deriveOjtBadgeFields）と考え方をそろえてある:
  //   ・rookie.csvが読み込まれていれば、常にそこから最新の状態を計算する
  //   ・未読み込みなら existing（変更前の人物オブジェクト）の新人バッジを維持する
  //   ・existingも無ければバッジなしにする
  // ただし rookieRank（新人1〜7の順位）は rookie.csv だけでは決まらず、
  // 「その日配置されている人の中で新人度合いが小さい順」で決まる。そのため
  // 順位はこの関数では確定させず、reapplyRookieRanks() が配置済みの全カードを
  // 見てから付け直す（この関数は isRookie の判定と度合いの保持までを行う）。
  function deriveRookieBadgeFields(name, existing) {
    const idx = appState.rookieIndexes;
    if (idx) {
      const has = idx.degreeOf.has(name);
      return {
        isRookie: has,
        rookieDegree: has ? idx.degreeOf.get(name) : null,
        rookieRank: has && existing && Number.isFinite(existing.rookieRank) ? existing.rookieRank : null,
      };
    }
    if (existing) {
      return {
        isRookie: !!existing.isRookie,
        rookieDegree: Number.isFinite(existing.rookieDegree) ? existing.rookieDegree : null,
        rookieRank: Number.isFinite(existing.rookieRank) ? existing.rookieRank : null,
      };
    }
    return { isRookie: false, rookieDegree: null, rookieRank: null };
  }

  function deriveOjtBadgeFields(name, existing) {
    const idx = appState.ojtIndexes;
    if (idx) {
      return {
        isOjtMentor: idx.isMentor.has(name),
        isOjtTrainee: idx.isTrainee.has(name),
        ojtMentorName: idx.mentorOf.get(name) || null,
        ojtTraineeNames: idx.traineesOf.get(name) || [],
      };
    }
    if (existing) {
      return {
        isOjtMentor: !!existing.isOjtMentor,
        isOjtTrainee: !!existing.isOjtTrainee,
        ojtMentorName: existing.ojtMentorName || null,
        ojtTraineeNames: Array.isArray(existing.ojtTraineeNames) ? existing.ojtTraineeNames : [],
      };
    }
    return { isOjtMentor: false, isOjtTrainee: false, ojtMentorName: null, ojtTraineeNames: [] };
  }

  // 指定した位置以外に、同じ人がすでにいないか確認する（手入力での重複防止）。
  // 二重配置の廃止（ver0.4.0）に伴い、夜勤GL枠・予備枠も含めた全エリアでチェックする。
  // 〈ver0.5.3で氏名からpkey（氏名|開始時刻）へ変更〉同日2回勤務は同じ氏名の
  // カードが2枚並ぶ正しい状態だが、氏名だけで判定していたため、どちらのカードも
  // ✎編集の保存時に必ず「既に使われています」となり、時刻の手直しすらできなかった。
  // 氏名と開始時刻の両方が他のカードと一致する場合のみ重複として扱う。
  function isPersonUsedElsewhere(pkey, loc) {
    for (const [seatType, seatState] of [['seat', appState.seats], ['nightSeat', appState.nightSeats]]) {
      for (const s of SEATS) {
        for (let i = 0; i < 2; i++) {
          if (loc.type === seatType && loc.seatKey === s.key && loc.slotIndex === i) continue;
          const p = seatState[s.key][i];
          if (p && personKey(p) === pkey) return true;
        }
      }
    }
    for (const [areaType, areaState] of [
      ['early', appState.early], ['late', appState.late],
      ['nightGL', appState.nightGL], ['nightSpare', appState.nightSpare],
    ]) {
      for (const key of Object.keys(areaState)) {
        if (loc.type === areaType && loc.key === key) continue;
        const p = areaState[key];
        if (p && personKey(p) === pkey) return true;
      }
    }
    for (const [ovType, ovList] of [['overflow', appState.overflow], ['nightOverflow', appState.nightOverflow]]) {
      for (let i = 0; i < ovList.length; i++) {
        if (loc.type === ovType && loc.index === i) continue;
        const p = ovList[i];
        if (p && personKey(p) === pkey) return true;
      }
    }
    return false;
  }

  // その日の配置から完全に削除する（あふれにも残らない）
  function deletePersonAt(loc) {
    setPersonAt(loc, null);
    appState.overflow = appState.overflow.filter(Boolean);
    appState.nightOverflow = appState.nightOverflow.filter(Boolean);
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

  // highlighted=true のとき、全探索backtrackの「次案を表示」「一部シャッフル」ボタンで
  // このカードの人が直前の表示から座席を変えたことを示す、一瞬光るハイライトを付ける
  // （CSS側のアニメーションで数秒かけて自然に消える。状態としては保持しない）。
  function createPersonCard(loc, person, highlighted) {
    const card = document.createElement('div');
    card.className = 'person-card' + (person.isRookie ? ' rookie' : '') + (highlighted ? ' candidate-changed' : '');
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
    if (person.hasPriorityFlag) {
      badges.appendChild(makeBadge('priority', '優先'));
    }
    if (person.isRookie) {
      badges.appendChild(makeBadge('rookie', person.rookieRank ? `新人${person.rookieRank}` : '新人'));
    }
    if (person.isDesignated) {
      const label = seatNumbersLabel(person.designatedSeatNumbers, '・');
      badges.appendChild(makeBadge('designated', '固定席', label));
    }
    if (person.isSupport) {
      const label = seatNumbersLabel(person.supportSeatNumbers, '・');
      badges.appendChild(makeBadge('support', '要サポ', label));
    }
    if (person.hasForbiddenSeatRule) {
      const label = seatNumbersLabel(person.forbiddenSeatNumbers, ',');
      badges.appendChild(makeBadge('lock', '禁止席', label));
    }
    if (person.hasAdjacentRule) {
      badges.appendChild(makeBadge('adjacent', '隣禁止', person.adjacentGroupLetter || ''));
    }
    if (person.hasNightGLDesignation) {
      badges.appendChild(makeBadge('designated', '夜勤', 'GL席'));
    }
    if (person.isOjtMentor) {
      badges.appendChild(makeBadge('mentor', '教官'));
    }
    if (person.isOjtTrainee) {
      badges.appendChild(makeBadge('mentor', 'OJT'));
    }
    card.appendChild(badges);

    card.addEventListener('dragstart', (e) => {
      dragSource = loc;
      e.dataTransfer.effectAllowed = 'move';
    });
    return card;
  }

  // 早番・遅番エリア・夜勤GL枠・予備枠用のカード（役席・GL）。
  // 1行目=氏名、2行目=時間、3行目は空欄。
  // 役席・GLは席が決まっているわけではなく動き回るため、バッジや枠番号は付けない。
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

    const timeLine = document.createElement('div');
    timeLine.className = 'leader-time';
    timeLine.appendChild(makeTimeSpan(person.start, person.frontOT));
    const sepSpan = document.createElement('span');
    sepSpan.className = 'time-sep';
    sepSpan.textContent = '-';
    timeLine.appendChild(sepSpan);
    timeLine.appendChild(makeTimeSpan(person.end, person.backOT));
    card.appendChild(timeLine);

    const blankLine = document.createElement('div');
    blankLine.className = 'leader-blank';
    card.appendChild(blankLine);

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
      // 重複判定は開始時刻も使うため、時刻の形式を確かめてから行う。〈ver0.5.3〉
      const newPkey = `${newName}|${newStart}`;
      if (isPersonUsedElsewhere(newPkey, loc)) {
        errorDiv.textContent = `「${newName}」（${newStart}開始）は既に他の座席・あふれで使われています。`;
        return;
      }

      const nameUnchanged = newName === person.name;
      const updated = {
        ...person,
        name: newName, start: newStart, end: newEnd, startMin, endMin,
        // 氏名・開始時刻が変わりうるため、識別子も作り直す。〈ver0.4.18〉
        pkey: newPkey,
        // 自動配置を実行した時点での識別子は、氏名を変えても保持する。〈ver0.5.3〉
        // 「次案を表示」「一部シャッフル」で座席表を作り直すときに、作り直しの元に
        // なった人物とこのカードとを対応づけるために使う（reconcileRebuilt参照）。
        originPkey: person.originPkey || person.pkey || `${person.name}|${person.start}`,
        // 氏名を変えていない場合は、変更前の人物を existing として渡す。〈ver0.5.3〉
        // ojt.csv / rookie.csv が未読み込みのとき（保存ファイルだけを開いた場合など）、
        // existing を渡さないと教官・OJT・新人のバッジを維持する手段が無く、
        // 時刻だけを直したつもりでバッジが消えていた。
        // 氏名を変えた場合は、前の人の情報を引き継がないよう existing は渡さない。
        ...deriveBadgeFields(newName, nameUnchanged ? person : undefined),
      };
      setPersonAt(loc, updated);
      // 新人の順位（新人1〜7）は「その日配置されている人の中での順」で決まるため、
      // 氏名の変更で対象者が入れ替わった場合に備えて付け直す。〈ver0.5.3〉
      // rookie.csvが未読み込みのときは何もしない（保存データの順位を維持する）。
      reapplyRookieRanks();
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
    if (loc.type === 'nightSeat') return appState.nightSeats[loc.seatKey][loc.slotIndex];
    if (loc.type === 'early') return appState.early[loc.key];
    if (loc.type === 'late') return appState.late[loc.key];
    if (loc.type === 'nightGL') return appState.nightGL[loc.key];
    if (loc.type === 'nightSpare') return appState.nightSpare[loc.key];
    if (loc.type === 'overflow') return appState.overflow[loc.index];
    if (loc.type === 'nightOverflow') return appState.nightOverflow[loc.index];
    return null;
  }
  function setPersonAt(loc, person) {
    if (loc.type === 'seat') appState.seats[loc.seatKey][loc.slotIndex] = person;
    else if (loc.type === 'nightSeat') appState.nightSeats[loc.seatKey][loc.slotIndex] = person;
    else if (loc.type === 'early') appState.early[loc.key] = person;
    else if (loc.type === 'late') appState.late[loc.key] = person;
    else if (loc.type === 'nightGL') appState.nightGL[loc.key] = person;
    else if (loc.type === 'nightSpare') appState.nightSpare[loc.key] = person;
    else if (loc.type === 'overflow') appState.overflow[loc.index] = person;
    else if (loc.type === 'nightOverflow') appState.nightOverflow[loc.index] = person;
  }

  // ドラッグ元とドロップ先の中身を入れ替える（人単位の移動・交換）。
  // ver0.4.0で二重配置を廃止したため、夜勤GL枠・予備枠も含め全エリア間で自由に移動できる。
  function handleDrop(target) {
    if (!dragSource) return;
    editingLoc = null; // ドラッグ操作が起きたら、開いていた編集フォームは閉じる
    if (target.type === 'overflow-append') {
      const person = getPersonAt(dragSource);
      if (!person) return;
      setPersonAt(dragSource, null);
      appState.overflow.push(person);
    } else if (target.type === 'night-overflow-append') {
      const person = getPersonAt(dragSource);
      if (!person) return;
      setPersonAt(dragSource, null);
      appState.nightOverflow.push(person);
    } else {
      const personA = getPersonAt(dragSource);
      const personB = getPersonAt(target);
      setPersonAt(dragSource, personB);
      setPersonAt(target, personA);
    }
    appState.overflow = appState.overflow.filter(Boolean); // 入れ替えで生じた穴を詰める
    appState.nightOverflow = appState.nightOverflow.filter(Boolean);
    dragSource = null;
    render();
  }

  // 座席のスロット1つ分（空席 or 人物カード or 編集フォーム）とドロップ受付を作る
  function makeDropTarget(el, loc) {
    el.addEventListener('dragover', (e) => { e.preventDefault(); el.classList.add('dragover'); });
    el.addEventListener('dragleave', () => el.classList.remove('dragover'));
    el.addEventListener('drop', (e) => { e.preventDefault(); el.classList.remove('dragover'); handleDrop(loc); });
  }

  function createSlot(loc, changedNames) {
    const slot = document.createElement('div');
    slot.className = 'slot';
    const person = getPersonAt(loc);
    if (person) {
      slot.classList.add('filled');
      const highlighted = !!(changedNames && changedNames.has(person.pkey || `${person.name}|${person.start}`));
      slot.appendChild(locEquals(loc, editingLoc) ? createEditForm(loc, person) : createPersonCard(loc, person, highlighted));
    } else {
      slot.textContent = '空席';
    }
    makeDropTarget(slot, loc);
    return slot;
  }

  // 座席グリッド（全15席）を描画する。日勤（locType='seat'）と夜勤（locType='nightSeat'）で共用。
  // changedNames が渡された場合、そこに含まれる氏名のカードにハイライトを付ける
  // （全探索backtrackの「次案を表示」「一部シャッフル」ボタンで直前と座席が変わった人を示す）。
  function renderSeatGrid(gridEl, locType, changedNames) {
    const grid = gridEl;
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

        seatDiv.appendChild(createSlot({ type: locType, seatKey: key, slotIndex: 0 }, changedNames));
        seatDiv.appendChild(createSlot({ type: locType, seatKey: key, slotIndex: 1 }, changedNames));

        grid.appendChild(seatDiv);
      }
    }
  }

  // 早番・遅番エリア・夜勤GL枠・予備枠（2行×3列、1枠1名）を描画する
  function renderLeaderGrid(containerEl, areaType) {
    if (!containerEl) return;
    containerEl.innerHTML = '';
    const stateObj = appState[areaType];
    LEADER_ROWS.forEach(row => {
      LEADER_COLS.forEach(col => {
        const key = `${row}-${col}`;
        const loc = { type: areaType, key };
        const cell = document.createElement('div');
        cell.className = 'leader-cell';

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

  // あふれ欄を描画する。日勤（'overflow'）と夜勤（'nightOverflow'）で共用。
  function renderOverflow(listEl, arr, locType, changedNames) {
    const list = listEl;
    list.innerHTML = '';
    if (arr.length === 0) {
      const note = document.createElement('div');
      note.className = 'overflow-empty-note';
      note.textContent = 'あふれはありません。';
      list.appendChild(note);
    } else {
      arr.forEach((person, i) => {
        const loc = { type: locType, index: i };
        const wrapper = document.createElement('div');
        wrapper.className = 'overflow-slot';
        const highlighted = !!(changedNames && changedNames.has(person.pkey || `${person.name}|${person.start}`));
        wrapper.appendChild(locEquals(loc, editingLoc) ? createEditForm(loc, person) : createPersonCard(loc, person, highlighted));
        makeDropTarget(wrapper, loc);
        list.appendChild(wrapper);
      });
    }
  }

  // 「3. 日勤 座席配置」「4. 夜勤 座席配置」の見出しに、現在の配置対象日を表示する
  // （appState.currentDateLabel は自動配置の実行時・保存データの読み込み時に設定される）
  function renderDateHeadings() {
    const suffix = appState.currentDateLabel ? `（${appState.currentDateLabel}）` : '';
    els.dayDateLabel.textContent = suffix;
    els.nightDateLabel.textContent = suffix;
  }

  // dayChangedNames / nightChangedNames（省略可、Set<string>）: 全探索backtrackの
  // 「次案を表示」「一部シャッフル」ボタンから呼ばれたときだけ渡される。渡された氏名の
  // カードに一瞬ハイライトを付ける（ドラッグ操作や✎編集など、それ以外からの
  // render()呼び出しでは何も渡さないため、ハイライトは付かない）。
  function render(dayChangedNames, nightChangedNames) {
    renderDateHeadings();
    renderLeaderGrid(els.earlyGrid, 'early');
    renderLeaderGrid(els.lateGrid, 'late');
    renderSeatGrid(els.seatGrid, 'seat', dayChangedNames);
    renderOverflow(els.overflowList, appState.overflow, 'overflow', dayChangedNames);
    renderLeaderGrid(els.nightSpareGrid, 'nightSpare');
    renderLeaderGrid(els.nightGlGrid, 'nightGL');
    renderSeatGrid(els.nightSeatGrid, 'nightSeat', nightChangedNames);
    renderOverflow(els.nightOverflowList, appState.nightOverflow, 'nightOverflow', nightChangedNames);
    renderCandidatePanel('day', appState.dayExhaustive);
    renderCandidatePanel('night', appState.nightExhaustive);
  }

  // ---------- 全探索backtrack：候補パネル（ver0.4.8で追加） ----------

  // 座席表(state)から「氏名 -> 座席key」のMapを作る（差分検出用）
  function collectSeatAssignments(state) {
    const map = new Map();
    for (const s of SEATS) {
      // 同日2回勤務の人は同じ氏名で2席に座るため、氏名だけでは差分が正しく取れない。
      // 氏名＋開始時刻（pkey相当）をキーにする。〈ver0.4.18〉
      state[s.key].forEach(p => { if (p) map.set(p.pkey || `${p.name}|${p.start}`, s.key); });
    }
    return map;
  }

  // 2つの座席表を比べて、座席が変わった（またはあふれに落ちた/あふれから復帰した）
  // 人の氏名の集合を返す。全探索backtrackの「次案を表示」「一部シャッフル」ボタンで、
  // 直前の表示と比べて何が変わったかを示すために使う。
  function diffChangedNames(prevState, nextState) {
    const prev = collectSeatAssignments(prevState);
    const next = collectSeatAssignments(nextState);
    const changed = new Set();
    for (const [name, seatKey] of next.entries()) {
      if (prev.get(name) !== seatKey) changed.add(name);
    }
    for (const name of prev.keys()) {
      if (!next.has(name)) changed.add(name);
    }
    return changed;
  }

  // 候補パネル（日勤 or 夜勤）の表示を更新する。exがnull（全探索backtrackが解けなかった/
  // まだ自動配置していない/保存データを読み込んだ直後）ならパネルごと隠す。
  // 「次案を表示」は隣接禁止対象者側の候補が1件しかない場合は押しても意味がないため
  // 無効化する。「一部シャッフル」は候補数によらず常に押せる（禁止席・その他側の
  // ランダム配置し直しには、候補が1件しかない場合でも意味があるため）。
  // 座席が変わった人は、候補欄の下に氏名を列挙するのではなく、座席カード自体を
  // 一瞬光らせて知らせる（changedNamesの利用先はrenderSeatGrid/renderOverflow側の
  // ハイライトのみ）。
  // 候補の「同格グループ」を判定する（ver0.4.17）。
  // solutions は algorithm.js 側で ①preferredMiss（指定席を守れなかった人数）→
  // ②boundaryMatches（交代時刻がぴったり重なる同席の数）→ ③variance（席の偏り）
  // の順に良い順で並んでいる。①②は同点が出やすい離散的な指標なので、
  // 先頭の案を基準に「①で劣る／②で劣る／どちらも同点」の3階層に分ける。
  // ③varianceは連続値でほぼ同点にならないため階層の判定には使わず、
  // 最良グループ内の並び順としてだけ効かせる（従来どおり）。
  // 劣後する案も隠さずに表示し、代わりにラベルで違いを知らせる方針。
  function candidateTiers(solutions) {
    const best = solutions[0].score;
    const tiers = solutions.map(sol => {
      if (sol.score.preferredMiss > best.preferredMiss) return 2;
      if (sol.score.boundaryMatches > best.boundaryMatches) return 1;
      return 0;
    });
    return { tiers, bestCount: tiers.filter(t => t === 0).length };
  }

  // 現在表示している候補につけるラベル（候補欄の下に出す）
  function candidateNote(ex) {
    const { tiers, bestCount } = candidateTiers(ex.solutions);
    const tier = tiers[ex.index];
    const cur = ex.solutions[ex.index].score;
    const best = ex.solutions[0].score;
    if (tier === 2) {
      return { tier, text: `指定席どおりでない方が${cur.preferredMiss}名` };
    }
    if (tier === 1) {
      return { tier, text: `同時刻入替が${cur.boundaryMatches - best.boundaryMatches}件多い案` };
    }
    return { tier, text: `最良グループ（${bestCount}件）` };
  }

  function renderCandidatePanel(prefix, ex) {
    const els2 = candidateEls[prefix];
    if (!els2 || !els2.inner) return;
    if (!ex || !ex.solutions || ex.solutions.length === 0) {
      els2.inner.hidden = true;
      return;
    }
    els2.inner.hidden = false;
    els2.count.textContent = `候補 ${ex.index + 1} / ${ex.solutions.length}`;
    if (els2.note) {
      const note = candidateNote(ex);
      els2.note.textContent = note.text;
      els2.note.classList.toggle('is-lower', note.tier > 0);
    }
    if (els2.btnNext) els2.btnNext.disabled = ex.solutions.length <= 1;
    // 「候補1に戻す」は先頭の候補を表示している間は押しても意味がないため無効化する
    if (els2.btnBest) els2.btnBest.disabled = ex.index === 0;
  }

  // prefix: 'day' | 'night'。seatsKey/overflowKey: appState上のプロパティ名。
  function setupCandidateButtons(prefix, getEx, seatsKey, overflowKey) {
    const els2 = candidateEls[prefix];
    if (!els2 || !els2.btnNext || !els2.btnShuffle) return;

    // 「次案を表示」ボタン（ver0.4.17。①隣接禁止対象者側の案を次の候補に進め、
    // ②続けてその新しい案の上で禁止席のみの対象者とその他スタッフをランダムに
    // 配置し直す、をセットで行う。候補が1件しかない場合はrenderCandidatePanelで
    // 無効化されるため、ここに来る時点で必ず2件以上ある）。
    // 指定した候補（index）を画面に反映する。「次案を表示」「候補1に戻す」で共通。
    function applyCandidate(ex, index) {
      const prevState = appState[seatsKey];
      ex.index = index;
      const reshuffled = reshuffleForbiddenAndOthers(ex.solutions[index], ex.context);
      // 座席表を差し替える前に、いまの画面の状態（削除・移動・✎編集）を集めておく
      const current = collectCurrentPeople();
      const nextState = reconcileRebuiltState(reshuffled.state, current, seatsKey, overflowKey);
      const nextOverflow = rebuildOverflowList(ex, reshuffled.overflow, seatsKey, overflowKey, current);
      appState[seatsKey] = nextState;
      appState[overflowKey] = nextOverflow;
      editingLoc = null;
      const changed = diffChangedNames(prevState, reshuffled.state);
      if (prefix === 'day') render(changed, undefined);
      else render(undefined, changed);
    }

    els2.btnNext.addEventListener('click', () => {
      const ex = getEx();
      if (!ex || ex.solutions.length <= 1) return;
      applyCandidate(ex, (ex.index + 1) % ex.solutions.length);
    });

    // 「候補1に戻す」ボタン（ver0.4.17で追加）: 候補は良い順に並んでおり逆送りが
    // できないため、行き過ぎたときに1クリックで先頭（最良の案）へ戻れるようにする。
    if (els2.btnBest) {
      els2.btnBest.addEventListener('click', () => {
        const ex = getEx();
        if (!ex || ex.index === 0) return;
        applyCandidate(ex, 0);
      });
    }

    // 「一部シャッフル」ボタン（旧「シャッフル」。ver0.4.17で改称）: 隣接禁止対象者・
    // 固定席・要サポート・教官OJT・新人固定席側の座席は変えず、禁止席のみの
    // 対象者とその他スタッフだけをランダムに配置し直す。
    els2.btnShuffle.addEventListener('click', () => {
      const ex = getEx();
      if (!ex) return;
      const base = ex.solutions[ex.index];
      const prevState = appState[seatsKey];
      const reshuffled = reshuffleForbiddenAndOthers(base, ex.context);
      // applyCandidateと同様、座席表の差し替え前に現在の状態を集めて調整する
      const current = collectCurrentPeople();
      const nextState = reconcileRebuiltState(reshuffled.state, current, seatsKey, overflowKey);
      const nextOverflow = rebuildOverflowList(ex, reshuffled.overflow, seatsKey, overflowKey, current);
      appState[seatsKey] = nextState;
      appState[overflowKey] = nextOverflow;
      editingLoc = null;
      const changed = diffChangedNames(prevState, reshuffled.state);
      if (prefix === 'day') render(changed, undefined);
      else render(undefined, changed);
    });
  }
  setupCandidateButtons('day', () => appState.dayExhaustive, 'seats', 'overflow');
  setupCandidateButtons('night', () => appState.nightExhaustive, 'nightSeats', 'nightOverflow');

  render();

  // ドラッグがドロップ対象の外で終了した場合でも、ハイライトが残らないようにする
  document.addEventListener('dragend', () => {
    document.querySelectorAll('.dragover').forEach(el => el.classList.remove('dragover'));
  });

  // ---------- 手動調整後のルールチェック ----------
  // 日勤・夜勤の両方の座席グリッドで secret.csv のルールと相席の時間重複をチェックし、
  // さらに全エリア（座席・早番/遅番・夜勤GL枠・予備枠・あふれ）を対象に
  // 日勤・夜勤の入れ違い（夜勤の人が日勤側にいる等）を検出する。
  function checkPlacementViolations() {
    // secret.csvが未読み込みの場合、固定席・禁止席・隣接禁止のチェックはできないが、
    // それ以外のチェック（同席の時間重複、日勤・夜勤の入れ違い、夜勤GL枠等）は
    // secret.csvに依存しないため、そちらは引き続き実行する
    const idx = appState.ruleIndexes;
    const forbiddenPairSet = idx ? idx.forbiddenPairSet : new Set();
    const forbiddenSeatSet = idx ? idx.forbiddenSeatSet : new Set();
    const designatedSeatsMap = idx ? idx.designatedSeatsMap : new Map();
    const supportSeatsMap = idx ? idx.supportSeatsMap : new Map();
    const violations = [];
    // 日勤・夜勤の入れ違い等の「warn」用ログ（教官・OJTがらみの同席メッセージも
    // ここに合流させるため、下の入れ違いチェックより前で宣言しておく）
    const crossShiftWarnings = [];
    if (!idx || !rawText.secret) {
      crossShiftWarnings.push('secret.csvが読み込まれていないため、固定席・禁止席・隣接禁止のチェックは行っていません。');
    }
    const ojtIdx = appState.ojtIndexes; // ojt.csv未読み込みならnull

    const grids = [
      { label: '【日勤】', seats: appState.seats },
      { label: '【夜勤】', seats: appState.nightSeats },
    ];

    for (const { label, seats } of grids) {
      const reportedAdjacentPairs = new Set();
      for (const s of SEATS) {
        const occHere = seats[s.key].filter(Boolean);

        // ルール2: 禁止席
        occHere.forEach(p => {
          if (forbiddenSeatSet.has(`${p.name}|${s.key}`)) {
            violations.push(`${label}${p.name}さんが禁止されている${numberOfKey(s.key)}番の座席に配置されています`);
          }
        });

        // 同席2名のうち、勤務時間が重なっていないか。
        // ・ojt.csvで紐づく教官・OJT本人同士の同席は、意図どおりのため違反にしない
        // ・OJT対象者が絡む同席（担当教官が不在で臨時教官を割り当てた場合など、
        //   ojt.csv上の組み合わせと一致しない場合）は、errorではなくwarnで
        //   「OJTと臨時教官の組み合わせであれば問題ない」旨を添えて確認を促す
        // ・OJTが絡まない同席は、これまでどおりerrorとして報告する
        if (occHere.length === 2 && overlaps(occHere[0], occHere[1])) {
          const [a, b] = occHere;
          const isRecognizedOjtPair = !!ojtIdx && (ojtIdx.mentorOf.get(a.name) === b.name || ojtIdx.mentorOf.get(b.name) === a.name);
          const involvesOjtTrainee = !!ojtIdx && (ojtIdx.isTrainee.has(a.name) || ojtIdx.isTrainee.has(b.name));
          if (isRecognizedOjtPair) {
            // 教官・OJTとして正しく紐づいている組み合わせのため、違反としては扱わない
          } else if (involvesOjtTrainee) {
            crossShiftWarnings.push(`${label}${numberOfKey(s.key)}番の座席で、勤務時間が重なる${a.name}さんと${b.name}さんが同席しています（OJTと臨時教官の組み合わせであれば問題ありません。意図した配置か確認してください）`);
          } else {
            violations.push(`${label}${numberOfKey(s.key)}番の座席で、勤務時間が重なる${a.name}さんと${b.name}さんが同席しています`);
          }
        }

        // ルール1: 隣接禁止（同じペアを2回報告しないようにする）
        for (const adjKey of ADJACENCY[s.key]) {
          const occAdj = seats[adjKey].filter(Boolean);
          occHere.forEach(a => occAdj.forEach(b => {
            if (isForbiddenPair(a.name, b.name, forbiddenPairSet)) {
              const pairId = [a.name, b.name].sort().join('|') + '@' + [s.key, adjKey].sort().join(',');
              if (!reportedAdjacentPairs.has(pairId)) {
                reportedAdjacentPairs.add(pairId);
                violations.push(`${label}${a.name}さんと${b.name}さんが隣接する座席に配置されています`);
              }
            }
          }));
        }
      }
    }

    // ルール3: 固定席・要サポートが守られているか（その日出勤している対象者のみ
    // チェック。日勤・夜勤どちらの座席グリッドでも、指定された座席番号に座っていればよい）
    const checkSeatCompliance = (seatsMap, label) => {
      for (const [name, seatKeys] of seatsMap.entries()) {
        const seatedAtList = [];
        for (const { label: gridLabel, seats } of grids) {
          const seatedAt = SEATS.find(s => seats[s.key].filter(Boolean).some(p => p.name === name));
          if (seatedAt) seatedAtList.push({ label: gridLabel, key: seatedAt.key });
        }
        const isInOverflow = appState.overflow.some(p => p && p.name === name)
          || appState.nightOverflow.some(p => p && p.name === name);
        if (seatedAtList.length === 0 && !isInOverflow) continue; // その日出勤していない

        const badPlacement = seatedAtList.length === 0 || seatedAtList.some(o => !seatKeys.includes(o.key));
        if (badPlacement) {
          const seatList = seatKeys.map(k => `${numberOfKey(k)}番`).join(' または ');
          violations.push(`${name}さんが${label}で指定された座席（${seatList}）に配置されていません`);
        }
      }
    };
    checkSeatCompliance(designatedSeatsMap, '固定席');
    checkSeatCompliance(supportSeatsMap, '要サポート');

    // ---- 日勤・夜勤の入れ違いチェック ----
    // 勤務時間から夜勤かどうか（開始が22:00より遅い、または終了が26:00より遅い）を
    // 判定し直し、日勤側に夜勤の人・夜勤側に日勤の人が配置されていれば知らせる。
    // 手動でのドラッグ移動や時刻の手入力修正で入れ違いになったケースを検出する。
    // （crossShiftWarnings 自体は関数冒頭、教官・OJTの同席チェックより前で宣言済み）
    const collectPeople = (locations) => {
      const result = [];
      locations.forEach(({ area, state, list }) => {
        if (state) Object.values(state).forEach(p => { if (p) result.push(p); });
        if (list) list.forEach(p => { if (p) result.push(p); });
        if (area) for (const s of SEATS) area[s.key].forEach(p => { if (p) result.push(p); });
      });
      return result;
    };
    const dayPeople = collectPeople([
      { area: appState.seats }, { state: appState.early }, { state: appState.late },
      { list: appState.overflow },
    ]);
    const nightPeople = collectPeople([
      { area: appState.nightSeats }, { state: appState.nightGL }, { state: appState.nightSpare },
      { list: appState.nightOverflow },
    ]);
    dayPeople.forEach(p => {
      if (isNightShift(p.startMin, p.endMin)) {
        crossShiftWarnings.push(`【日勤】${p.name}さん（${p.start}-${p.end}）は夜勤の勤務時間ですが、日勤側に配置されています`);
      }
    });
    nightPeople.forEach(p => {
      if (!isNightShift(p.startMin, p.endMin)) {
        crossShiftWarnings.push(`【夜勤】${p.name}さん（${p.start}-${p.end}）は日勤の勤務時間ですが、夜勤側に配置されています`);
      }
    });

    // ---- 夜勤GL枠が空になっていないかのチェック ----
    // その日の配置のどこかに夜勤の役席・GL（役割と勤務時間の両方で判定）がいるのに、
    // 夜勤GL枠に役席・GLが1人もいない場合に警告する。夜勤GL枠のカードを手動で
    // 座席1〜15へ動かした・OPと入れ替えた・削除した、といったケースを検出するためのもの。
    // 夜勤の役席・GLがそもそも1人もいない日は、夜勤GL枠が空でも警告しない。
    const isLeaderRole = p => p.role === '役席' || p.role === 'GL';
    const glFrameHasLeader = Object.values(appState.nightGL).some(p => p && isLeaderRole(p));
    if (!glFrameHasLeader) {
      const nightLeadersElsewhere = [...dayPeople, ...nightPeople]
        .filter(p => isLeaderRole(p) && isNightShift(p.startMin, p.endMin));
      if (nightLeadersElsewhere.length > 0) {
        const names = nightLeadersElsewhere.map(p => `${p.name}さん`).join('、');
        crossShiftWarnings.push(`【夜勤】夜勤GL枠に役席・GLが配置されていません。夜勤の役席・GL（${names}）のうち1名を夜勤GL枠へ移動してください`);
      }
    }

    // ---- 早番・遅番・夜勤GL枠にOPが手動配置されていないかのチェック ----
    // これらの枠は役席・GL専用（algorithm.jsのassignLeaderAreas/assignNightLeaders参照）。
    // ドラッグ&ドロップでOPを紛れ込ませてしまった場合に検出する。
    const leaderFrames = [
      { label: '早番', state: appState.early },
      { label: '遅番', state: appState.late },
      { label: '夜勤GL', state: appState.nightGL },
    ];
    leaderFrames.forEach(({ label, state }) => {
      Object.values(state).forEach(p => {
        if (p && p.role === 'OP') {
          violations.push(`${label}枠にOPの${p.name}さんが配置されています（${label}枠は役席・GL専用です）`);
        }
      });
    });

    const resultLogs = [
      ...violations.map(m => ({ level: 'error', message: m })),
      ...crossShiftWarnings.map(m => ({ level: 'warn', message: m })),
    ];
    renderMessages(resultLogs.length === 0
      ? [{ level: 'info', message: '違反は見つかりませんでした。' }]
      : resultLogs);
    scrollToMessages();
  }
  document.getElementById('btn-check').addEventListener('click', checkPlacementViolations);

  // ---------- 配置の保存・読み込み（ver0.4.3で追加 / ver0.4.6でダウンロード方式に変更） ----------
  // 「現在の配置を保存」: いま画面に表示されている配置（手動調整・✎編集の内容を含む）
  // をJSONファイルとしてダウンロードする（保存先はブラウザの既定のダウンロード
  // フォルダになる。ブラウザ側で毎回保存先を確認する設定の場合はそちらが優先される）。
  // 「保存した配置を読み込む」: ファイル選択ダイアログでJSONファイルを1つ選ぶと、
  // 保存した時点の配置画面を復元する。
  //
  // フォルダへの直接読み書き（File System Access API）は使わない。ダウンロード・
  // ファイル選択のいずれも読み書き権限の確認ダイアログを必要としない一般的な
  // ブラウザ操作のため、余計な権限確認は発生しない。
  //
  // 保存ファイルには secret.csv から推測できる情報（固定席・禁止席・隣接禁止・
  // 夜勤GL席の対象かどうか、対象座席番号、グループ記号などのバッジ情報）を
  // 一切含めない。バッジは読み込み時に、その時点でブラウザに読み込まれている
  // secret.csv から再計算して付け直す（reapplyBadges）。
  const SAVE_FILE_MARK = '座席配置ツール保存データ';
  const SAVE_FORMAT_VERSION = 1;

  function pad2(n) { return String(n).padStart(2, '0'); }

  // ---- 保存データの組み立て ----
  // 1人分のうち、保存してよい最小限の項目だけを書き出す（ホワイトリスト方式）。
  // secret.csv由来のバッジ情報（isDesignated / designatedSeatNumbers /
  // forbiddenSeatNumbers / hasAdjacentRule / hasForbiddenSeatRule /
  // adjacentGroupLetter / hasNightGLDesignation）は、保存ファイルから固定席・
  // 禁止席などの内容を推測できてしまうため、ここで確実に落とす。
  // isRookie/rookieRank（新人固定席）と、isOjtMentor/isOjtTrainee/ojtMentorName/
  // ojtTraineeNames（教官・OJT。ver0.4.14で追加）は例外として保存する。
  // これらはsecret.csvの禁止席・隣接禁止のような「配置の制約」を推測させる
  // 情報ではなく、rookie.csv/ojt.csvが読み込まれていない環境で保存データを
  // 開いた場合にもバッジ表示が失われないようにするための情報のため。
  function exportPerson(p) {
    if (!p) return null;
    return {
      name: p.name, start: p.start, end: p.end,
      // 同日2回勤務の識別子。〈ver0.4.18で追加。古い保存ファイルには無いが、
      // 復元時にsanitizePersonが氏名＋開始時刻から補完する〉
      pkey: typeof p.pkey === 'string' && p.pkey ? p.pkey : `${p.name}|${p.start}`,
      frontOT: !!p.frontOT, backOT: !!p.backOT,
      role: p.role === '役席' || p.role === 'GL' ? p.role : 'OP',
      isRookie: !!p.isRookie,
      rookieRank: Number.isFinite(p.rookieRank) ? p.rookieRank : null,
      // 新人度合い〈ver0.4.19で追加〉。読み込み後に順位を付け直すために保存する
      rookieDegree: Number.isFinite(p.rookieDegree) ? p.rookieDegree : null,
      isOjtMentor: !!p.isOjtMentor,
      isOjtTrainee: !!p.isOjtTrainee,
      ojtMentorName: typeof p.ojtMentorName === 'string' ? p.ojtMentorName : null,
      ojtTraineeNames: Array.isArray(p.ojtTraineeNames) ? p.ojtTraineeNames.filter(n => typeof n === 'string') : [],
    };
  }
  function exportSeatState(state) {
    const out = {};
    for (const s of SEATS) out[s.key] = [exportPerson(state[s.key][0]), exportPerson(state[s.key][1])];
    return out;
  }
  function exportLeaderState(state) {
    const out = {};
    LEADER_ROWS.forEach(r => LEADER_COLS.forEach(c => { const k = `${r}-${c}`; out[k] = exportPerson(state[k]); }));
    return out;
  }
  function exportOverflow(list) { return list.filter(Boolean).map(exportPerson); }

  function buildSaveData() {
    const now = new Date();
    const targetDatePart = (appState.currentDate || '').replace(/-/g, '') || '保存';
    const savedAtPart = `${now.getFullYear()}${pad2(now.getMonth() + 1)}${pad2(now.getDate())}_${pad2(now.getHours())}${pad2(now.getMinutes())}`;
    const data = {
      fileType: SAVE_FILE_MARK,
      formatVersion: SAVE_FORMAT_VERSION,
      savedAt: `${now.getFullYear()}/${pad2(now.getMonth() + 1)}/${pad2(now.getDate())} ${pad2(now.getHours())}:${pad2(now.getMinutes())}`,
      currentDate: appState.currentDate,
      currentDateLabel: appState.currentDateLabel,
      seats: exportSeatState(appState.seats),
      early: exportLeaderState(appState.early),
      late: exportLeaderState(appState.late),
      overflow: exportOverflow(appState.overflow),
      nightSeats: exportSeatState(appState.nightSeats),
      nightGL: exportLeaderState(appState.nightGL),
      nightSpare: exportLeaderState(appState.nightSpare),
      nightOverflow: exportOverflow(appState.nightOverflow),
    };
    const filename = `座席配置_${targetDatePart}_保存日時_${savedAtPart}.json`;
    return { data, filename };
  }

  // ---- 保存（従来方式: JSONファイルのダウンロード） ----
  // File System Access API 非対応のブラウザ（Firefox / Safari など）向けのフォールバック。
  // <a download> 方式のため、保存先はブラウザの既定のダウンロードフォルダに固定される。
  function saveByDownload(data, filename) {
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  // ---- 保存（File System Access API: 保存先選択ダイアログ） ----
  // showSaveFilePicker() に対応したブラウザ（Chrome / Edge 等）では、
  // 「名前をつけて保存」と同様のダイアログで保存先フォルダとファイル名を選ばせる。
  // ユーザーがファイルを選んだ時点で書き込み許可が自動的に与えられる仕様のため、
  // 別途「このサイトにファイルの編集を許可しますか」という確認は表示されない。
  function supportsSaveFilePicker() {
    return typeof window.showSaveFilePicker === 'function' && window.isSecureContext;
  }
  async function saveByPicker(data, filename) {
    const handle = await window.showSaveFilePicker({
      suggestedName: filename,
      types: [{ description: 'JSON ファイル', accept: { 'application/json': ['.json'] } }],
    });
    const writable = await handle.createWritable();
    await writable.write(JSON.stringify(data, null, 2));
    await writable.close();
  }

  document.getElementById('btn-save').addEventListener('click', async () => {
    if (!hasRunOnce) {
      alert('保存できる配置がありません。先に「自動配置を実行」するか、保存した配置を読み込んでください。');
      return;
    }
    const { data, filename } = buildSaveData();

    if (supportsSaveFilePicker()) {
      try {
        await saveByPicker(data, filename);
        renderMessages([{ level: 'info', message: `配置を保存しました（${filename}）。` }]);
      } catch (err) {
        if (err && err.name === 'AbortError') {
          // ユーザーが保存ダイアログをキャンセルした場合は何もしない
          return;
        }
        // 想定外のエラー時は従来方式（ダウンロード）にフォールバックする
        saveByDownload(data, filename);
        renderMessages([{ level: 'warn', message: `保存先選択でエラーが発生したため、ダウンロードフォルダに保存しました（${filename}）。` }]);
      }
    } else {
      saveByDownload(data, filename);
      renderMessages([{ level: 'info', message: `配置をダウンロードしました（${filename}）。ブラウザの既定のダウンロード先に保存されます。` }]);
    }
    // 保存はその場で完了する操作のため、メッセージ欄へのスクロールは行わない
  });

  // ---- 読み込み ----

  // 読み込み時の復元ヘルパー: 保存データ内の「1人分」を検証して復元する。
  // 保存してある項目だけを取り込むホワイトリスト方式のため、手を加えられた
  // 保存ファイルに余計な項目が入っていてもここで確実に落とす（secret.csv由来の
  // バッジ情報は後段の reapplyBadges でsecret.csvから再計算する。
  // isRookie/rookieRankと、isOjtMentor/isOjtTrainee/ojtMentorName/ojtTraineeNames
  // 〈ver0.4.14で追加〉は保存データにそのまま含まれているため、ここでそのまま
  // 取り込む。ojt.csvが読み込まれていればreapplyBadgesで最新の内容に更新され、
  // 読み込まれていなければこの保存データの内容がそのまま使われる）。
  // 壊れているエントリはnull（空席扱い）にして読み飛ばし、氏名が分かるものは
  // brokenNamesに集めて警告に使う。
  function sanitizePerson(p, brokenNames) {
    if (!p || typeof p !== 'object') return null;
    const name = typeof p.name === 'string' ? p.name.trim() : '';
    if (!name) return null;
    const start = typeof p.start === 'string' ? p.start : '';
    const end = typeof p.end === 'string' ? p.end : '';
    const startMin = timeToMinutes(start);
    const endMin = timeToMinutes(end);
    if (startMin == null || endMin == null) {
      brokenNames.push(name);
      return null;
    }
    return {
      name, start, end, startMin, endMin,
      // 同日2回勤務を区別する識別子。〈ver0.4.18で追加〉
      // 既存の保存ファイルにはpkeyが無いため、氏名＋開始時刻から補完する
      // （csv.js側と同じ組み立て方のため、同じ値になる）。
      pkey: typeof p.pkey === 'string' && p.pkey ? p.pkey : `${name}|${start}`,
      frontOT: !!p.frontOT, backOT: !!p.backOT,
      role: p.role === '役席' || p.role === 'GL' ? p.role : 'OP',
      isRookie: !!p.isRookie,
      rookieRank: Number.isFinite(p.rookieRank) ? p.rookieRank : null,
      // 新人度合い〈ver0.4.19で追加〉。読み込み後に順位を付け直すために保存する
      rookieDegree: Number.isFinite(p.rookieDegree) ? p.rookieDegree : null,
      isOjtMentor: !!p.isOjtMentor,
      isOjtTrainee: !!p.isOjtTrainee,
      ojtMentorName: typeof p.ojtMentorName === 'string' ? p.ojtMentorName : null,
      ojtTraineeNames: Array.isArray(p.ojtTraineeNames) ? p.ojtTraineeNames.filter(n => typeof n === 'string') : [],
    };
  }

  function restoreSeatState(saved, brokenNames) {
    const state = initEmptyState();
    if (saved && typeof saved === 'object') {
      for (const s of SEATS) {
        const slots = Array.isArray(saved[s.key]) ? saved[s.key] : [];
        state[s.key][0] = sanitizePerson(slots[0], brokenNames);
        state[s.key][1] = sanitizePerson(slots[1], brokenNames);
      }
    }
    return state;
  }

  function restoreLeaderState(saved, brokenNames) {
    const state = initLeaderState();
    if (saved && typeof saved === 'object') {
      LEADER_ROWS.forEach(r => LEADER_COLS.forEach(c => {
        const key = `${r}-${c}`;
        state[key] = sanitizePerson(saved[key], brokenNames);
      }));
    }
    return state;
  }

  function restoreOverflow(saved, brokenNames) {
    if (!Array.isArray(saved)) return [];
    return saved.map(p => sanitizePerson(p, brokenNames)).filter(Boolean);
  }

  // 配置済みの全カードに、現在のsecret.csvルール（appState.ruleIndexes）から
  // バッジ情報を付け直す。secret.csvが未読み込み（ruleIndexes=null）の場合は
  // バッジなしになる。対象はバッジが表示されるエリア（日勤・夜勤の座席グリッドと
  // あふれ）のみ。「夜勤GL席」バッジは夜勤側の座席・あふれにいる対象者にのみ付け、
  // 夜勤GL枠に入っている本人には付けない（枠に選ばれなかった人を示すバッジのため）。
  function reapplyBadges() {
    const idx = appState.ruleIndexes;
    const nightGLNames = idx ? idx.nightGLDesignatedNames : new Set();
    const apply = (p, isNightSide) => {
      if (!p) return p;
      return {
        ...p,
        ...deriveBadgeFields(p.name, p),
        hasNightGLDesignation: isNightSide && nightGLNames.has(p.name),
      };
    };
    // ※ deriveBadgeFields は内部で deriveOjtBadgeFields も呼ぶため、
    // ojt.csv由来のisOjtMentor/isOjtTrainee等もここで一緒に再計算される
    // （ojt.csvが未読み込みの場合は、pが持つ既存の教官・OJTバッジ情報を維持する。
    // 保存データを読み込んだ直後は、保存ファイル自身が持つ情報がここに渡る）。
    for (const s of SEATS) {
      for (let i = 0; i < 2; i++) {
        appState.seats[s.key][i] = apply(appState.seats[s.key][i], false);
        appState.nightSeats[s.key][i] = apply(appState.nightSeats[s.key][i], true);
      }
    }
    appState.overflow = appState.overflow.map(p => apply(p, false));
    appState.nightOverflow = appState.nightOverflow.map(p => apply(p, true));
    reapplyRookieRanks();
  }

  // 新人バッジの順位（新人1〜7）を、いま配置されている人を対象に付け直す。
  // 〈ver0.4.19で追加〉rookie.csvが未読み込みのときは、保存データが持っている
  // 順位をそのまま使う（何もしない）。
  // 順位の決め方は algorithm.js の「新人（固定席）の対象者・順位の決定」と同じ:
  //   新人度合いが小さいほど新人として優先。同数値のときは後から出てくる人をより新人とする
  //   （自動配置時は月間シフトCSVの行順で判定するが、保存データにはその行順が
  //   残っていないため、ここでは日勤→夜勤・座席番号順の並びで代用する）。
  // 日勤・夜勤はそれぞれ別に順位を振る（自動配置時も別々に計算されるため）。
  function reapplyRookieRanks() {
    const idx = appState.rookieIndexes;
    if (!idx) return;
    const rankSide = (seatState, overflowList) => {
      const found = [];
      SEATS.forEach(s => {
        for (let i = 0; i < 2; i++) {
          const p = seatState[s.key][i];
          if (p && p.isRookie) found.push({ p, order: found.length });
        }
      });
      overflowList.forEach(p => { if (p && p.isRookie) found.push({ p, order: found.length }); });
      found.sort((a, b) => {
        const da = Number.isFinite(a.p.rookieDegree) ? a.p.rookieDegree : Infinity;
        const db = Number.isFinite(b.p.rookieDegree) ? b.p.rookieDegree : Infinity;
        if (da !== db) return da - db;
        return b.order - a.order;
      });
      found.forEach((entry, i) => {
        entry.p.rookieRank = i < idx.rookieSeatCount ? i + 1 : null;
      });
    };
    rankSide(appState.seats, appState.overflow);
    rankSide(appState.nightSeats, appState.nightOverflow);
  }

  // 保存ファイルのテキストを検証してオブジェクトにする。問題があればerrorを返す
  function parseSaveJsonText(text) {
    let data;
    try {
      data = JSON.parse(text);
    } catch (e) {
      return { error: '保存ファイルを読み込めませんでした。ファイルが壊れているか、本ツールの保存データではない可能性があります。' };
    }
    if (!data || data.fileType !== SAVE_FILE_MARK || !Number.isFinite(data.formatVersion)) {
      return { error: 'このファイルは本ツールの保存データではないようです。「現在の配置を保存」で出力したJSONファイルを選択してください。' };
    }
    if (data.formatVersion > SAVE_FORMAT_VERSION) {
      return { error: 'この保存ファイルは、より新しいバージョンのツールで作成されています。ツールを最新版に更新してから読み込んでください。' };
    }
    return { data };
  }

  // 検証済みの保存データを画面へ反映する
  function applySaveData(data) {
    const brokenNames = [];
    appState.seats = restoreSeatState(data.seats, brokenNames);
    appState.early = restoreLeaderState(data.early, brokenNames);
    appState.late = restoreLeaderState(data.late, brokenNames);
    appState.overflow = restoreOverflow(data.overflow, brokenNames);
    appState.nightSeats = restoreSeatState(data.nightSeats, brokenNames);
    appState.nightGL = restoreLeaderState(data.nightGL, brokenNames);
    appState.nightSpare = restoreLeaderState(data.nightSpare, brokenNames);
    appState.nightOverflow = restoreOverflow(data.nightOverflow, brokenNames);
    // secret.csv由来のルールとバッジ情報は保存ファイルには含まれていないため、
    // その時点でブラウザに読み込まれているsecret.csv（rawText.secret）から作り直す。
    // secret.csvが未読み込みの場合はルールなし・バッジなしにしておき、後から
    // secret.csvを読み込んだ時点で自動的に反映される（loadFileInto内のフック）。
    let secretNote;
    if (rawText.secret) {
      const secretParsed = parseSecretRows(rawText.secret, seatByNumber);
      appState.secretRows = secretParsed.rows;
      appState.ruleIndexes = buildSecretIndexes(secretParsed.rows);
      appState.adjacentGroupLetters = buildAdjacentGroups(secretParsed.rows);
      secretNote = { level: 'info', message: '読み込み済みのsecret.csvから、違反チェック用のルールとバッジ表示を構築しました。' };
    } else {
      appState.secretRows = null;
      appState.ruleIndexes = null;
      appState.adjacentGroupLetters = null;
      secretNote = { level: 'warn', message: 'secret.csvが読み込まれていないため、禁止席・隣接禁止・固定席の違反チェックとバッジ表示は使用できません。secret.csvを読み込むと自動的に有効になります。' };
    }
    // ojt.csv由来の情報（教官・OJTのバッジ、違反チェックでの同席の例外扱い）も
    // 保存ファイルには含まれていないため、同様にその場のojt.csvから作り直す
    let ojtNote = null;
    if (rawText.ojt) {
      const ojtParsed = parseOjtRows(rawText.ojt, seatByNumber);
      appState.ojtRows = ojtParsed.rows;
      appState.ojtIndexes = buildOjtIndexes(ojtParsed.rows);
      ojtNote = { level: 'info', message: '読み込み済みのojt.csvから、教官・OJTのバッジ表示を構築しました。' };
    } else {
      appState.ojtRows = null;
      appState.ojtIndexes = null;
    }
    // rookie.csv由来の新人バッジも同じ扱い（ver0.4.19）。読み込まれていればそちらを
    // 正として付け直し、未読み込みなら保存ファイルが持っている内容を維持する。
    let rookieNote = null;
    if (rawText.rookie) {
      const rookieParsed = parseRookieRows(rawText.rookie);
      appState.rookieRows = rookieParsed.rows;
      appState.rookieIndexes = buildRookieIndexes(rookieParsed.rows);
      rookieNote = { level: 'info', message: '読み込み済みのrookie.csvから、新人のバッジ表示を構築しました。' };
    } else {
      appState.rookieRows = null;
      appState.rookieIndexes = null;
    }
    reapplyBadges();
    appState.currentDate = typeof data.currentDate === 'string' ? data.currentDate : null;
    appState.currentDateLabel = typeof data.currentDateLabel === 'string' ? data.currentDateLabel : null;
    // 保存データには全探索backtrackの候補情報は含まれないため、
    // 読み込み時は候補パネルを非表示に戻す（「次案を表示」「一部シャッフル」ボタンは、
    // 直前に「自動配置を実行」した内容にのみ対応しているため）。
    appState.dayExhaustive = null;
    appState.nightExhaustive = null;
    hasRunOnce = true;
    editingLoc = null;

    const logs = [{
      level: 'info',
      message: `保存した配置を読み込みました（対象日: ${appState.currentDateLabel || '不明'} ／ 保存日時: ${typeof data.savedAt === 'string' ? data.savedAt : '不明'}）。`,
    }, secretNote];
    if (ojtNote) logs.push(ojtNote);
    if (rookieNote) logs.push(rookieNote);
    if (brokenNames.length > 0) {
      logs.push({
        level: 'warn',
        message: `保存データの一部が壊れていたため、次の方を読み飛ばしました: ${Array.from(new Set(brokenNames)).join('、')}`,
      });
    }
    renderMessages(logs);
    render();
    scrollToMessages();
  }

  const loadInput = document.getElementById('file-load');

  document.getElementById('btn-load').addEventListener('click', () => {
    if (hasRunOnce && !confirm('現在表示中の配置は失われます。保存した配置を読み込みますか？')) return;
    loadInput.click();
  });

  loadInput.addEventListener('change', async () => {
    const file = loadInput.files[0];
    loadInput.value = ''; // 同じファイルを選び直しても change が発火するようにする
    if (!file) return;
    let text;
    try {
      text = await file.text();
    } catch (e) {
      alert('保存ファイルを読み込めませんでした。');
      return;
    }
    const parsed = parseSaveJsonText(text);
    if (parsed.error) { alert(parsed.error); return; }
    applySaveData(parsed.data);
  });

  // ---------- 印刷用ページ ----------
  function escapeHtml(s) {
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  // 残業（前残業/後残業）の時刻表示。黄色の背景＋「※」マークで示す
  // （背景色が印刷されない設定でも※は必ず印刷される。背景色自体はCSS側で指定）
  function printTimeSpan(text, isOT) {
    if (!isOT) return `<span class="pt">${escapeHtml(text)}</span>`;
    return `<span class="pt ot">${escapeHtml(text)}<sup class="ot-mark">※</sup></span>`;
  }

  // 座席1枠内の「1人分」を描画する。人がいなければ空のまま（枠の大きさは常に揃える）
  // coordLabel: 座席番号（1人目にだけ、氏名と同じ行の右端に表示する。2人目はnull）
  // 手書き用の余白（線なし）は1人目・2人目とも残す
  function printOccupantHtml(p, coordLabel) {
    const coordHtml = coordLabel ? `<span class="print-coord">${escapeHtml(coordLabel)}</span>` : '';
    if (!p) {
      return `<div class="print-occupant">${coordLabel ? `<div class="print-name-row">${coordHtml}</div>` : ''}<div class="print-blank"></div></div>`;
    }
    return '<div class="print-occupant">'
      + `<div class="print-name-row"><span class="print-name">${escapeHtml(p.name)}</span>${coordHtml}</div>`
      + `<div class="print-time">${printTimeSpan(p.start, p.frontOT)}<span class="pt-sep">-</span>${printTimeSpan(p.end, p.backOT)}</div>`
      + '<div class="print-blank"></div>'
      + '</div>';
  }

  // 早番・遅番エリア・夜勤GL枠・予備枠（2行×3列）を1つ分描画する。動き回って座席が
  // 決まっていないため、枠番号・役割は表示しない（1行目=氏名、2行目=時間、3行目は空欄）。
  // label が空文字の場合は、見出しの高さだけ確保した無題の枠になる。
  function printLeaderColumnHtml(stateObj, label) {
    let cellsHtml = '';
    LEADER_ROWS.forEach(row => {
      LEADER_COLS.forEach(col => {
        const p = stateObj ? stateObj[`${row}-${col}`] : null;
        cellsHtml += '<div class="print-leader-cell">';
        if (p) {
          cellsHtml += `<div class="print-leader-name">${escapeHtml(p.name)}</div>`
            + `<div class="print-leader-time">${printTimeSpan(p.start, p.frontOT)}<span class="pt-sep">-</span>${printTimeSpan(p.end, p.backOT)}</div>`
            + '<div class="print-leader-blank"></div>';
        }
        cellsHtml += '</div>';
      });
    });
    const titleHtml = label ? escapeHtml(label) : '&nbsp;';
    return `<div class="print-leader-col"><div class="print-leader-frame"><h3>${titleHtml}</h3><div class="print-leader-grid">${cellsHtml}</div></div></div>`;
  }

  // 座席グリッド（全15席）の印刷用HTML。日勤・夜勤で共用（渡された座席stateを描画する）。
  function printSeatGridHtml(seatsState) {
    // 1〜2列目・3〜4列目は向かい合わせのため間隔なし、2〜3列目（通路）だけ間隔を残す。
    // そのため5列構成のグリッド（1,2,通路,3,4）にして、座席は列1,2,4,5へ配置する。
    const gridColumnOf = (col) => (col <= 2 ? col : col + 1);
    let gridHtml = '<div class="print-grid">';
    for (let row = 1; row <= 4; row++) {
      for (let col = 1; col <= 4; col++) {
        if (!seatExists(row, col)) continue; // 存在しない席（右下）は何も描画しない
        const slots = seatsState[`${row}-${col}`]; // [人 or null, 人 or null]（常に2枠）
        const style = `grid-column:${gridColumnOf(col)}; grid-row:${row};`;
        gridHtml += `<div class="print-seat" style="${style}">`
          + printOccupantHtml(slots[0], String(numberOfSeat(row, col)))
          + '<div class="print-divider"></div>'
          + printOccupantHtml(slots[1], null)
          + '</div>';
      }
    }
    gridHtml += '</div>';
    return gridHtml;
  }

  // あふれ一覧の印刷用HTML（0件なら空文字）
  function printOverflowHtml(overflowArr) {
    if (overflowArr.length === 0) return '';
    return '<div class="print-overflow"><h2>あふれ</h2><ul>'
      + overflowArr.map(p => `<li>${escapeHtml(p.name)}（${escapeHtml(p.start)} - ${escapeHtml(p.end)}）</li>`).join('')
      + '</ul></div>';
    // ※ 一覧のレイアウト（1行3列）は <style> 側の .print-overflow ul で指定
  }

  // 印刷用ページは2ページ構成: 1ページ目=日勤、2ページ目=夜勤（A4各1枚。両面コピー用）
  function buildPrintHtml(dateLabel, generatedLabel) {
    // --- 1ページ目: 日勤 ---
    const dayLeaderHtml = '<div class="print-leader-section">'
      + printLeaderColumnHtml(appState.early, '早番')
      + printLeaderColumnHtml(appState.late, '遅番')
      + '</div>';
    const dayGridHtml = printSeatGridHtml(appState.seats);
    const dayOverflowHtml = printOverflowHtml(appState.overflow);

    // 残業（※マーク）が1件でもあれば、意味を説明する凡例を表示する（ページごとに判定）
    const dayHasOT = SEATS.some(s => (appState.seats[s.key] || []).some(p => p && (p.frontOT || p.backOT)))
      || Object.values(appState.early).some(p => p && (p.frontOT || p.backOT))
      || Object.values(appState.late).some(p => p && (p.frontOT || p.backOT));
    const dayLegendHtml = dayHasOT ? '<div class="print-legend">※…残業（前残業＝出勤時刻／後残業＝退勤時刻）</div>' : '';

    // --- 2ページ目: 夜勤 ---
    // 左＝見出しなしの予備枠（通常は空。手動で置いた場合はその内容を印刷）、右＝夜勤GL枠
    const nightLeaderHtml = '<div class="print-leader-section">'
      + printLeaderColumnHtml(appState.nightSpare, '')
      + printLeaderColumnHtml(appState.nightGL, '夜勤GL')
      + '</div>';
    const nightGridHtml = printSeatGridHtml(appState.nightSeats);
    const nightOverflowHtml = printOverflowHtml(appState.nightOverflow);

    const nightHasOT = SEATS.some(s => (appState.nightSeats[s.key] || []).some(p => p && (p.frontOT || p.backOT)))
      || Object.values(appState.nightGL).some(p => p && (p.frontOT || p.backOT))
      || Object.values(appState.nightSpare).some(p => p && (p.frontOT || p.backOT));
    const nightLegendHtml = nightHasOT ? '<div class="print-legend">※…残業（前残業＝出勤時刻／後残業＝退勤時刻）</div>' : '';

    return `<!DOCTYPE html>
<html lang="ja">
<head>
<meta charset="UTF-8">
<title>${escapeHtml(dateLabel)} 座席表</title>
<style>
  @page { size: A4 portrait; margin: 4mm 14mm; }
  * { box-sizing: border-box; }
  body { font-family: "Yu Gothic UI","Meiryo","Hiragino Kaku Gothic ProN",sans-serif; color:#222; margin:0; }
  /* 1ページ目=日勤、2ページ目=夜勤。2ページ目の前で必ず改ページする */
  .print-page + .print-page { break-before: page; page-break-before: always; }
  .print-generated { text-align:right; font-size:11px; color:#999; margin-bottom:0.5mm; }
  .print-title { text-align:center; font-size:24px; font-weight:700; margin-bottom:4mm; }
  .print-legend { font-size:10.5px; color:#777; text-align:right; margin:-2mm 0 2.5mm; }

  .print-leader-section { display:flex; gap:5mm; width:172mm; margin-bottom:4mm; }
  .print-leader-col { width:83.5mm; }
  .print-leader-frame { border:1px solid #888; border-radius:2mm; padding:1.3mm; }
  .print-leader-frame h3 { font-size:12px; margin:0 0 1mm; color:#333; }
  .print-leader-grid { display:grid; grid-template-columns:repeat(3, 1fr); gap:0.8mm; }
  .print-leader-cell { border:1px solid #555; border-radius:1.5mm; height:16mm; padding:1mm 1mm 0.6mm; display:flex; flex-direction:column; justify-content:center; align-items:center; text-align:center; overflow:hidden; }
  .print-leader-name { font-size:16px; font-weight:600; line-height:1.15; max-width:100%; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
  .print-leader-time { font-size:16px; color:#555; margin-top:0.3mm; white-space:nowrap; }
  .print-leader-blank { flex:1 1 auto; min-height:1mm; }

  .print-grid { display:grid; grid-template-columns:41.75mm 41.75mm 5mm 41.75mm 41.75mm; grid-auto-rows:44mm; column-gap:0; row-gap:0; width:172mm; }
  .print-seat { position:relative; border:1px solid #333; border-radius:3mm; padding:2mm 2.5mm; height:44mm; display:flex; flex-direction:column; }
  .print-occupant { flex:1 1 0; display:flex; flex-direction:column; min-height:0; text-align:center; }
  .print-name-row { position:relative; }
  .print-coord { position:absolute; right:0; top:0; font-size:12px; font-weight:700; color:#888; line-height:1; }
  .print-name { font-size:16px; font-weight:600; }
  .print-time { font-size:16px; color:#555; margin-top:0.5mm; }
  .print-blank { flex:1; }
  /* 残業の目印: 画面・印刷（プレビュー含む）どちらも黄色で塗りつぶす。
     以前は印刷時のみ薄いグレーに切り替える案（Excelの「12.5%灰色」相当）を
     試したが、環境によって印刷に反映されなかったため、黄色に統一している。 */
  .print-time .pt.ot, .print-leader-time .pt.ot {
    font-weight:700; padding:0 0.6mm; border-radius:0.3mm;
    background-color:#FFF3B0;
  }
  .ot-mark { font-size:8px; vertical-align:top; margin-left:0.3mm; }
  .pt-sep { margin:0 0.5mm; color:#777; }
  .print-divider { border-top:1px dashed #999; }
  .print-overflow { margin-top:6mm; }
  .print-overflow h2 { font-size:16px; border-bottom:1px solid #333; padding-bottom:2mm; }
  .print-overflow ul { list-style:none; margin:0; padding:0; display:grid; grid-template-columns:repeat(3, 1fr); gap:1.5mm 6mm; }
  .print-overflow li { font-size:15px; margin:0; }
  .no-print { text-align:center; margin-bottom:8mm; }
  .no-print button { font-size:15px; padding:9px 18px; cursor:pointer; }
  @media print { .no-print { display:none; } }
</style>
</head>
<body>
  <div class="no-print"><button onclick="window.print()">この内容を印刷する（1枚目: 日勤 / 2枚目: 夜勤）</button></div>
  <div class="print-page">
    <div class="print-generated">出力: ${escapeHtml(generatedLabel)}</div>
    <div class="print-title">${escapeHtml(dateLabel)} 日勤 座席表</div>
    ${dayLegendHtml}
    ${dayLeaderHtml}
    ${dayGridHtml}
    ${dayOverflowHtml}
  </div>
  <div class="print-page">
    <div class="print-generated">出力: ${escapeHtml(generatedLabel)}</div>
    <div class="print-title">${escapeHtml(dateLabel)} 夜勤 座席表</div>
    ${nightLegendHtml}
    ${nightLeaderHtml}
    ${nightGridHtml}
    ${nightOverflowHtml}
  </div>
</body>
</html>`;
  }

  document.getElementById('btn-print').addEventListener('click', () => {
    const today = new Date();
    const pad = n => String(n).padStart(2, '0');
    const todayLabel = `${today.getFullYear()}年${pad(today.getMonth() + 1)}月${pad(today.getDate())}日`;
    const defaultLabel = appState.currentDateLabel || todayLabel;
    const dateLabel = prompt('座席表の日付はあっていますか？（修正があれば入力してください）', defaultLabel);
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

    // 日付確認のOKを押した時点で、追加のクリックなしに印刷プレビュー（ブラウザの
    // 印刷ダイアログ）まで進める。document.write直後はレイアウト未確定のことがある
    // ため、load イベントを待ってから呼び出す。onloadが発火しない環境向けの保険として
    // 短いタイムアウトでも一度だけ呼び出す（printedフラグで二重呼び出しを防ぐ）。
    // ページ側の「この内容を印刷する」ボタンは、印刷ダイアログを誤って閉じた場合の
    // 手動の再印刷手段として残す。
    let printed = false;
    const triggerPrint = () => {
      if (printed) return;
      printed = true;
      win.focus();
      win.print();
    };
    win.onload = triggerPrint;
    setTimeout(triggerPrint, 300);
  });

})(window.SeatTool);
// ============================================================
// ui.js
// 画面の描画、ドラッグ&ドロップ、ファイル入力、配置の保存・読み込み、
// 印刷ページ出力を担当する。
// csv.js と algorithm.js が先に読み込まれている前提。
// ============================================================
(function (NS) {
  "use strict";

  const {
    parseShiftMonthlyRows, rowsForDate, yearMonthLabelFromDates, yearMonthOf,
    parseRookieRows, parseSecretRows, parseOjtRows, timeToMinutes, normalizeTime, isNightShift,
    normalizeOTKind, nameKey, displayName, preflightCsv, HEADER_SPECS,
  } = NS.csv;
  const {
    SEATS, seatExists, ADJACENCY, assignSeats, assignLeaderAreas, assignNightLeaders,
    buildSecretIndexes, buildAdjacentGroups, buildAdjacentPairs, formatAdjacentLabel,
    overlaps, isForbiddenPair,
    seatByNumber, numberOfKey, numberOfSeat, buildOjtIndexes, buildRookieIndexes,
    assignSeatsWithEscalation, reshuffleForbiddenAndOthers, ADJACENT_ESCALATION_MAX_LEVEL,
    remainingSeatKeysAfterForbidden,
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
    '優先フラグ → 新人固定席 → 教官・OJT → 固定席 → 要サポート → 隣接禁止 → 禁止席だけの人 → その他',
    '優先フラグ → 新人固定席 → 教官・OJT → 固定席 → 隣接禁止 → 要サポート → 禁止席だけの人 → その他',
    '優先フラグ → 新人固定席 → 教官・OJT → 隣接禁止 → 固定席 → 要サポート → 禁止席だけの人 → その他',
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
  // 読み込み時に弾いたファイル（A-1 ヘッダー不一致 / A-2 文字化け）のキー。
  // 〈ver0.5.7.2で追加〉弾かれたファイルは rawText が null になるため、
  // そのまま実行すると「はじめから渡していない場合」と全く同じ扱いになり、
  // ルールの効いていない座席表が青いお知らせ1行だけで完成してしまう。
  // 利用者は渡したつもりでいるので、実行前に確認を出すためにここで覚えておく。
  const rejectedFiles = new Set();
  // 任意CSVが無い／読み込めなかったときに「何が効かないのか」を伝えるための言い換え。
  // 実行前の確認ダイアログとメッセージ欄の両方で同じ言葉を使う〈ver0.5.7.2〉。
  const OPTIONAL_RULE_LABELS = {
    rookie: '新人固定席',
    secret: '固定席・禁止席・隣接禁止・要サポート・優先フラグのルール',
    ojt: '教官・OJTの同席',
  };
  const appState = {
    seats: initEmptyState(), early: initLeaderState(), late: initLeaderState(),
    overflow: [],
    // nightGL=夜勤GL枠（右側）、nightSpare=見出しなしの予備枠（左側・手書き/一時置き用）
    nightSeats: initEmptyState(), nightGL: initLeaderState(), nightSpare: initLeaderState(),
    nightOverflow: [],
    ruleIndexes: null, adjacentGroupLetters: null,
    // 隣接禁止のペア単位の情報（氏名 -> [{ letter, partner }, …]）。〈ver0.5.4で追加〉
    // 「相手が本日出勤しているペアの記号だけ残す」判定に使う。
    adjacentPairs: null,
    // その日のシフト上の出勤者の氏名（日勤側／夜勤側で別々に持つ）。〈ver0.5.4で追加〉
    // 隣接禁止バッジ・教官バッジの出し分けに使う。日勤の座席表と夜勤の座席表は
    // 完全に別物で、日勤の人と夜勤の人が隣り合ったり同席したりすることはないため、
    // 判定も必ず同じ側の中だけで行う。
    // nullのとき（自動配置も保存データ読み込みもまだの状態）は出し分けを行わない
    // ＝従来どおり全部表示する。
    dayRosterNames: null, nightRosterNames: null,
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
  let shiftMonthly = null; // 月間シフトCSVのパース結果 { rows, logs, dates, nameMap }

  // 氏名の表記を、いま読み込まれている月間シフトCSVの表記に寄せる。〈ver0.5.6で追加〉
  // 設定ファイル（secret.csv / ojt.csv / rookie.csv）の解析と、氏名の手入力編集で使う。
  // 姓名の間のスペースの入れ方だけを揃えるもので、氏名そのものは書き換えない。
  // 月間シフトCSVに無い氏名（休職者など）や未読み込みのときは、表記を整えるだけで返す
  // （従来どおり、その氏名の指定は静かに効かない）。
  function resolveName(raw) {
    const disp = displayName(raw);
    if (!disp) return '';
    const map = shiftMonthly && shiftMonthly.nameMap;
    return (map && map.get(nameKey(disp))) || disp;
  }

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
  function markFileFailed(key, note) {
    const el = fileStatusEls[key];
    el.textContent = note || '読み込みに失敗しました';
    el.classList.add('empty');
  }

  // ---------- 読み込み結果のまとめ表示 ----------
  // 〈ver0.5.7.1で追加〉ファイル1つごとにメッセージ欄を書き換えていたため、
  // まとめてドラッグ&ドロップすると、先に出したエラーが後続のファイルの表示
  // （「バッジ表示を更新しました」など）で消えてしまっていた。ダイアログも
  // ファイルの数だけ続けて出ていた。読み込み処理の間はここにためて、
  // 最後に1回だけメッセージ欄とダイアログに出す。
  let loadBatch = null;
  // 読み込み処理が同時に何本走っているか。〈ver0.5.7.3で追加〉
  // loadFileInto は非同期のため、読み込み中にもう一度ドラッグ&ドロップされると
  // beginLoadBatch が2回走り、先に終わったほうが両方分をまとめて出したうえで
  // loadBatch を空にしてしまい、後から終わったファイルのメッセージが消えていた。
  // 深さを数えて、最後の1本が終わったときにだけまとめて出す。
  let loadBatchDepth = 0;

  function beginLoadBatch() {
    loadBatchDepth++;
    if (!loadBatch) loadBatch = { logs: [], failedLabels: [], loadedLabels: [], unmatched: [] };
  }

  // メッセージ欄への出力。まとめ表示中はためるだけにする。
  function emitMessages(logs) {
    if (loadBatch) { loadBatch.logs.push(...logs); return; }
    renderMessages(logs);
    scrollToMessages();
  }

  // 読み込めなかったファイルの記録。ダイアログはまとめ終了時に1回だけ出す。
  function noteLoadFailure(label) {
    if (loadBatch) { loadBatch.failedLabels.push(label); return; }
    alert(`${label}を読み込めませんでした。\n\n`
      + '内容は画面の「2. メッセージ」欄（赤色）に表示しています。修正してから、もう一度読み込んでください。');
  }

  // 読み込めたファイルの記録。〈ver0.5.7.3で追加〉
  function noteLoadSuccess(label) {
    if (loadBatch) loadBatch.loadedLabels.push(label);
  }

  // ダイアログ・メッセージに出すファイルの呼び名は HEADER_SPECS に揃える
  function fileLabel(key) {
    return (HEADER_SPECS[key] && HEADER_SPECS[key].label) || key;
  }

  function endLoadBatch() {
    loadBatchDepth = Math.max(0, loadBatchDepth - 1);
    if (loadBatchDepth > 0) return; // まだ読み込み中のファイルがある
    const batch = loadBatch;
    loadBatch = null;
    if (!batch) return;
    // 〈ver0.5.7.3で変更〉読み込みが終わったら、メッセージ欄を必ず描き直す。
    // ver0.5.7.2までは出すものが1件も無いと描き直していなかったため、弾かれた
    // ファイルを直して読み込み直しても、前回の赤いエラーがそのまま残っていた。
    // 「読み込み済み」の表示と画面のメッセージが食い違い、直ったのかどうかが
    // 分からない状態になる。読み込めたファイル名を必ず1行出して打ち消す。
    // ダイアログを出すかどうか（＝読み込めなかったファイル・種類が分からなかった
    // ファイルがあるか）を先に決める。メッセージ欄へスクロールするのはこの場合だけに
    // するため。〈ver0.5.7.3〉
    // ダイアログは「読み込めていないこと」に気づかせるだけにし、詳細は
    // メッセージ欄で読ませる（実行時の中断ダイアログと同じ考え方）。
    const lines = [];
    if (batch.failedLabels.length === 1) {
      lines.push(`${batch.failedLabels[0]}を読み込めませんでした。`);
    } else if (batch.failedLabels.length > 1) {
      lines.push(`${batch.failedLabels.length}個のファイルを読み込めませんでした（${batch.failedLabels.join(' / ')}）。`);
    }
    if (batch.unmatched.length > 0) {
      lines.push(`ファイル名から種類を判別できなかったファイルがあります（${batch.unmatched.join(' / ')}）。`);
    }

    if (batch.logs.length > 0 || batch.loadedLabels.length > 0) {
      const loadedLogs = batch.loadedLabels.length > 0
        ? [{ level: 'info', message: `${batch.loadedLabels.join(' / ')}を読み込みました。` }]
        : [];
      // 赤（読み込めなかったもの）を先頭に置く。実行時の中断と並びを揃える。
      // 読み込めたファイルの行はその次に置き、残りの警告・お知らせを続ける。
      renderMessages([
        ...batch.logs.filter(l => l.level === 'error'),
        ...loadedLogs,
        ...batch.logs.filter(l => l.level !== 'error'),
      ]);
      // 〈ver0.5.7.3で変更〉全部読み込めたときは画面を動かさない。
      // 読み込みの次の操作（配置対象日の選択・自動配置を実行・追加のファイルの読み込み）は
      // すべて「1. CSV読み込み」の中にあるため、下のメッセージ欄へ飛ばすと必ず戻る操作が
      // 要る。読み込み時に行うのは見出しと文字コードの確認だけで、中身の解析は
      // 「自動配置を実行」まで行わない。つまりここで出るのはヘッダー不一致・文字化け・
      // ファイル名不明だけで、いずれも下のダイアログとセットになる。
      // 読ませる必要があるとき＝ダイアログを出すときだけスクロールする。
      if (lines.length > 0) scrollToMessages();
    }
    if (lines.length === 0) return;
    const where = batch.failedLabels.length > 0 ? '「2. メッセージ」欄（赤色）' : '「2. メッセージ」欄';
    alert(`${lines.join('\n')}\n\n内容は画面の${where}に表示しています。修正してから、もう一度読み込んでください。`);
  }

  // 読み込みを取り消して、そのファイルを未読み込みの状態に戻す。〈ver0.5.7で追加〉
  // ヘッダーの不一致・文字化けは全行が別の意味で読まれるため、そのまま採用すると
  // 黙って間違った座席表ができてしまう。前に読めていた内容も残さない
  // （どちらが使われているのか分からなくなるため）。
  // なお画面の座席表はそのまま残す。まだ「作り直す」と言われていない段階のため、
  // 表示中の座席表は正しい内容のまま（日付ラベルも一致している）。
  function rejectFile(key, messages) {
    rawText[key] = null;
    rejectedFiles.add(key);
    markFileFailed(key, '読み込めませんでした（下記のメッセージをご確認ください）');
    if (key === 'shift') { shiftMonthly = null; populateDateSelect(null); }
    emitMessages(messages.map(message => ({ level: 'error', message })));
    noteLoadFailure(fileLabel(key));
  }

  async function loadFileInto(key, file) {
    try {
      const text = await file.text();
      // ---- 読み込み時の中断（A-1 ヘッダー不一致 / A-2 文字化け）〈ver0.5.7で追加〉 ----
      // secret.csv / ojt.csv / rookie.csv は「自動配置を実行」まで解析しないため、
      // ここでチェックしないと不正なファイルに気づけるのが実行時までずれ込む。
      const pre = preflightCsv(key, text);
      if (!pre.ok) { rejectFile(key, pre.messages); return; }
      rawText[key] = text;
      rejectedFiles.delete(key); // 読み直して通ったので、弾いた記録は消す〈ver0.5.7.2〉
      markFileLoaded(key, file.name);
      noteLoadSuccess(fileLabel(key));
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
      rawText[key] = null;
      rejectedFiles.add(key);
      markFileFailed(key);
      if (key === 'shift') { shiftMonthly = null; populateDateSelect(null); }
      emitMessages([{ level: 'error', message: `${fileLabel(key)}のファイルを開けませんでした。ファイルが移動・削除されていないかご確認ください。` }]);
      noteLoadFailure(fileLabel(key));
    }
  }

  // 現在読み込まれているsecret.csv（rawText.secret）から、違反チェック用の
  // ruleIndexes / adjacentGroupLetters を作り直し、配置済みカードのバッジ表示も
  // 再計算して画面を更新する。secret.csvが未読み込みの場合は何もしない
  // （呼び出し側でrawText.secretの有無を見て呼ぶこと）。
  function refreshRuleIndexesFromSecret() {
    const secretParsed = parseSecretRows(rawText.secret, seatByNumber, resolveName);
    appState.secretRows = secretParsed.rows;
    appState.ruleIndexes = buildSecretIndexes(secretParsed.rows);
    appState.adjacentGroupLetters = buildAdjacentGroups(secretParsed.rows);
    appState.adjacentPairs = buildAdjacentPairs(secretParsed.rows);
    // 全探索backtrackの候補は旧secret.csvの内容で計算済みのため、ここでは無効化する
    // （「次案を表示」「一部シャッフル」ボタンを押すと矛盾した内容になってしまうため）
    appState.dayExhaustive = null;
    appState.nightExhaustive = null;
    reapplyBadges();
    render();
    emitMessages([
      ...secretParsed.logs,
      { level: 'info', message: '違反チェック用のルールとバッジ表示を、いまのsecret.csvで更新しました。' },
      ...buildBadgeVisibilityLogs(),
    ]);
  }

  // secret.csvと同様、現在読み込まれているojt.csv（rawText.ojt）から
  // ojtIndexesを作り直し、配置済みカードの教官・OJTバッジ表示を再計算する。
  // ※座席そのものの再配置は行わない（既存の配置を崩さないため）。
  function refreshOjtIndexesFromOjt() {
    const ojtParsed = parseOjtRows(rawText.ojt, seatByNumber, resolveName);
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
    emitMessages([
      ...ojtParsed.logs,
      { level: 'info', message: '教官・OJTのバッジ表示を、いまのojt.csvで更新しました（既存の座席配置は変更していません。反映するには自動配置をやり直してください）。' },
      ...buildBadgeVisibilityLogs(),
    ]);
  }
  // rookie.csvも同様（ver0.4.19）。読み込んだ時点で新人バッジを付け直す。
  // ※座席そのものの再配置は行わない（既存の配置を崩さないため）。
  function refreshRookieIndexesFromRookie() {
    const rookieParsed = parseRookieRows(rawText.rookie, resolveName);
    appState.rookieRows = rookieParsed.rows;
    appState.rookieIndexes = buildRookieIndexes(rookieParsed.rows);
    // ojt.csvと同じ理由で候補を無効化する〈ver0.5.2〉
    appState.dayExhaustive = null;
    appState.nightExhaustive = null;
    reapplyBadges();
    render();
    emitMessages([
      ...rookieParsed.logs,
      { level: 'info', message: '新人のバッジ表示を、いまのrookie.csvで更新しました（既存の座席配置は変更していません。反映するには自動配置をやり直してください）。' },
    ]);
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
      emitMessages([
        {
          level: 'error',
          message: '月間シフトCSVから、配置に使える行を1件も読み取れませんでした。下記の内容を元のExcelで修正し、CSVを出力し直してください。',
        },
        ...shiftMonthly.logs,
      ]);
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
    // 〈ver0.5.7.2で変更〉年末年始のシフトは12月＋翌1月上旬が1つのCSVに入る。
    // 従来は全部「1日（木）」のように日にちだけを出していたため、12月の末尾に
    // 1月の日付がそのまま続いて見え、1か月違いで選んでしまう恐れがあった。
    // 先頭の年月と違う日付にだけ「1月1日（木）」と月を付ける（2つ目以降の月は
    // すべての日に付ける。境目の1件だけに付けると、下へスクロールした人には
    // それが何月なのか分からないため）。単月のCSVでは従来どおり日にちだけになる。
    const firstYm = yearMonthOf(dates[0]);
    dates.forEach(d => {
      const opt = document.createElement('option');
      opt.value = d;
      const dt = new Date(d + 'T00:00:00');
      const ym = yearMonthOf(d);
      const monthPart = (firstYm && ym && ym.key !== firstYm.key) ? `${ym.m}月` : '';
      opt.textContent = `${monthPart}${dt.getDate()}日（${WEEKDAY_NAMES[dt.getDay()]}）`;
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
      // ドロップ時と同じ経路にするため、1ファイルでもまとめ表示を通す。
      // 途中で例外が出てもまとめを必ず閉じる（閉じ忘れると、以降の読み込みで
      // メッセージが1件も出なくなってしまうため）。〈ver0.5.7.3〉
      beginLoadBatch();
      try {
        await loadFileInto(key, file);
      } finally {
        endLoadBatch();
      }
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

    // ファイル1つごとにメッセージ欄を書き換えると、先に出したエラーが
    // 後続のファイルの表示で消えてしまう。まとめてためて最後に1回出す。〈ver0.5.7.1〉
    beginLoadBatch();
    try {
      const unmatched = [];
      for (const file of files) {
        const key = classifyFileName(file.name);
        if (!key) { unmatched.push(file.name); continue; }
        await loadFileInto(key, file);
      }
      if (unmatched.length > 0) {
        loadBatch.unmatched.push(...unmatched);
        loadBatch.logs.push({
          level: 'warn',
          message: `ファイル名から種類を判別できませんでした: ${unmatched.join(', ')}\nファイル名に shift / rookie / secret / ojt のいずれかを含めてください。`,
        });
      }
    } finally {
      endLoadBatch();
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
      // 「次案を表示」を案内せず、「一部シャッフル」（禁止席だけの人・その他側は
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

  // ============================================================
  // 実行時に中断する条件（B-1〜B-9）〈ver0.5.7で追加・整理〉
  // ============================================================
  // 切り分けの基準は「その行が読み飛ばされたこと・指定が無視されたことに、
  // 完成した座席表を見て気づけるか」。気づけないものは、黙って間違った座席表が
  // 印刷されてしまうため配置そのものを止める。気づけるものは続行してメッセージに出す。
  //
  // 判定の対象は「選択日に出勤している人」に関するものだけに限る。出勤していない人の
  // 設定矛盾はその日の座席表に影響せず、全員を対象にすると休職者の行が残っている
  // だけで毎日止まってしまう。
  //
  // 「早番・遅番エリア／夜勤GL枠へ回る役席・GLには座席1〜15のルールが効かないので、
  // その日は止めなくてよい」という絞り込みは行わない。バッジはCSVに書かれているか
  // どうかだけで決まり（deriveBadgeFields）、枠へ回った人にも付けているため
  // （reapplyLeaderBadges）、手動で座席へ動かした時点で矛盾したバッジが説明なしに
  // 表示されてしまう。例えば種別なしの優先フラグを見逃すと、「優先」バッジだけが
  // 単独で付いたカードができ、しかもその表示は事実と違う（手で動かした人であって、
  // 最優先で席が決まった人ではない）。
  // 例外はB-6の教官のみ（担当するOJT対象者が1人も出勤していない日は、教官は通常の
  // スタッフとして配置されるため矛盾にならない。§4の「教官×固定席」と同じ扱い）。
  //
  // 戻り値は中断理由の文字列の配列（空なら中断しない）。
  // 中断理由は一度に全部返す。最初の1件で打ち切ると
  // 「直す→再実行→次のエラー」の繰り返しになるため。
  function collectBlockingProblems(ctx) {
    const {
      selectedDate, skippedRows, secretParsed, ojtParsed, rookieParsed, ojtIndexes,
      dayRows, opRows, nightOpRows, nightLeaderRows,
    } = ctx;
    const problems = [];

    // 選択日に出勤している人（早番・遅番エリアへ回る役席・GLも含む）。B-1〜B-9の判定対象。
    const attendeeNames = new Set(dayRows.map(r => r.name));
    // そのうち、座席1〜15に並ぶ人。B-6（教官・OJTの優先フラグ）の判定にだけ使う。
    // 教官・OJTの同席処理が実際に動く日かどうかを見るためで、夜勤の役席・GLは
    // 1名が夜勤GL枠・2人目以降が座席側になるが、ここでは区別せず座席側として扱う。
    const seatSideNames = new Set([...opRows, ...nightOpRows, ...nightLeaderRows].map(r => r.name));

    // ---- B-8 選択日の行が読み飛ばされた（月間シフトCSV） ----
    // 読み飛ばされた人は座席表から丸ごと消える。このツールには人を後から追加する
    // 機能がないため、続行しても復旧できない。
    // 日付そのものが読めなかった行は、どの日の勤務か判別できないため日付を問わず対象。
    const skippedHere = (skippedRows || []).filter(r => r.date === selectedDate || r.date == null);
    if (skippedHere.length > 0) {
      const lines = skippedHere.map(r => {
        const who = r.name ? `（${r.name}）` : '';
        const undated = r.date == null ? '　※どの日の勤務か判別できないため、日付を問わず中断しています' : '';
        return `・${r.rowNumber}行目${who}：${r.reason}${undated}`;
      });
      problems.push(
        '月間シフトCSVに、読み飛ばした行があります。読み飛ばされた方は座席表から消えたまま、あとから追加することができません。\n'
        + lines.join('\n')
        + '\n元のExcelを修正し、CSVを出力し直してください。'
      );
    }

    // ---- B-1 secret.csv：同じ人が同じ種別に複数行 ----
    const secretDuplicateMessage = (kind, name) =>
      `secret.csv：「${name}」さんが「${kind}」に複数行あります。1人1行にまとめ、複数の座席は半角または全角スペース区切りで指定してください。`;
    [
      ['固定席', secretParsed.duplicateDesignatedNames],
      ['禁止席', secretParsed.duplicateForbiddenNames],
      ['要サポート', secretParsed.duplicateSupportNames],
    ].forEach(([kind, names]) => {
      (names || []).filter(name => attendeeNames.has(name))
        .forEach(name => problems.push(secretDuplicateMessage(kind, name)));
    });

    // ---- B-2 ojt.csv：同じ教官が複数行 ----
    // 2行目以降は読み飛ばされ、そこに書かれたOJT対象者は担当教官を失う。
    // 教官本人が休みでも、2行目のOJT対象者が出勤していれば座席表に影響する。
    (ojtParsed.duplicateMentors || []).forEach(({ name, relatedNames }) => {
      if (!relatedNames.some(n => attendeeNames.has(n))) return;
      problems.push(`ojt.csv：教官「${name}」さんが複数行にあります。1名につき1行にまとめ、OJT対象者は「OJT一人目」「OJT二人目」の列に並べてください。`);
    });

    // ---- B-3 ojt.csv：同じOJT対象者が複数の教官に ----
    (ojtParsed.duplicateTrainees || []).forEach(({ name, mentorNames }) => {
      if (!attendeeNames.has(name)) return;
      problems.push(`ojt.csv：OJT対象者「${name}」さんが複数の教官（${(mentorNames || []).join('・')}）に紐づいています。担当教官を1名に統一してください。`);
    });

    const secretIdx = buildSecretIndexes(secretParsed.rows);
    const rookieNames = new Set((rookieParsed.rows || []).map(r => r.name));
    const flagMap = secretIdx.priorityFlagMap;

    // ---- B-4 座る席を指名するルールが1人に2つ以上当たっている ----
    // 座る席を指名するルールは次の4つで、この優先順に処理される。
    //   新人固定席 → 教官・OJT → 固定席 → 要サポート
    // 2つ以上当たっていると、優先順位の後ろにあるルールはメッセージも出さずに消える。
    // 「OJT対象者が本日休み」の場合と結果が見分けられないため、座席表を見て気づけない。
    //
    // 教官は対象に含めない。担当するOJT対象者がその日1人も出勤していなければ、
    // 教官は通常のスタッフとして配置されるため、固定席・要サポートとの併記は矛盾ではない。
    // 固定席の「夜勤GL席」も対象外（指名先が夜勤GL枠で、座席1〜15ではないため）。
    // designatedSeatsMap には座席番号の指定だけが入るため、判定はそのまま使える。
    const ruleSourceFile = { '新人': 'rookie.csv', 'OJT対象者': 'ojt.csv', '固定席': 'secret.csv', '要サポート': 'secret.csv' };
    for (const name of attendeeNames) {
      const held = [];
      if (rookieNames.has(name)) held.push('新人');
      if (ojtIndexes && ojtIndexes.isTrainee.has(name)) held.push('OJT対象者');
      if (secretIdx.designatedSeatsMap.has(name)) held.push('固定席');
      if (secretIdx.supportSeatsMap.has(name)) held.push('要サポート');
      if (held.length < 2) continue;
      const files = [...new Set(held.map(h => ruleSourceFile[h]))].join(' / ');
      let message = `${files}：「${name}」さんは、${held.join('と')}に登録されています。`
        + '固定席・要サポート・新人・OJTは、1人にどれか1つだけです。'
        + `この4つはどれも「座る席を指名する」ものなので、2つ以上あると後のほう（${held.slice(1).join('・')}）が無視されます。`;
      // 新人×固定席／要サポートのときだけ、正しい行き先を示す。
      // 示さないと、優先フラグを付けて回避しようとされてしまう。
      if (held.includes('新人') && (held.includes('固定席') || held.includes('要サポート'))) {
        message += '\n新人の座席を指定したい場合は、優先フラグではなく作成者にご連絡ください（対応方法をご相談します）。';
      }
      problems.push(message);
    }

    // ---- B-5 固定席・要サポートで指定した座席が、同じ人の禁止席にも入っている ----
    // 論理矛盾。そのまま実行すると「指定された座席に配置できません」という
    // 理由の分からないメッセージだけが出る。座席番号を挙げて知らせれば一発で直せる。
    for (const name of attendeeNames) {
      const forbidden = new Set(secretIdx.forbiddenSeatsMap.get(name) || []);
      if (forbidden.size === 0) continue;
      [['固定席', secretIdx.designatedSeatsMap], ['要サポート', secretIdx.supportSeatsMap]].forEach(([label, map]) => {
        const overlap = (map.get(name) || []).filter(k => forbidden.has(k));
        if (overlap.length === 0) return;
        const nums = overlap.map(k => `${numberOfKey(k)}番`).join('・');
        problems.push(`secret.csv：「${name}」さんの座席${nums}が、${label}と禁止席の両方に指定されています。どちらか一方を消してください。`);
      });
    }

    // ---- B-6 教官・OJT対象者に優先フラグが付いている ----
    // 優先フラグの処理は全ルールの中で最初に走るため、教官・OJTの処理に入る時点で
    // どちらか一方が既に着席済みとなり、2人を隣り合わせられない。
    // 教官・OJTの処理そのものが動かない日（担当するOJT対象者が全員休みなど）は、
    // 優先フラグを付けても矛盾にならないため対象外とする。
    const ojtRows = ojtParsed.rows || [];
    const anyMentorOnSeatSide = ojtRows.some(r => seatSideNames.has(r.mentorName));
    ojtRows.forEach(r => {
      if (!flagMap.has(r.mentorName)) return;
      if (!seatSideNames.has(r.mentorName)) return;
      if (!r.trainees.some(t => seatSideNames.has(t))) return;
      problems.push(
        `secret.csv：「${r.mentorName}」さんは ojt.csv で教官として登録されていますが、優先フラグも設定されています。\n`
        + '優先フラグを付けた人は、他のどのルールよりも先に、1人だけで席が決まります。'
        + 'そのため教官として処理される時点では既に着席済みとなり、OJT対象者と隣り合わせることができません。'
        + 'この状態では「担当教官が本日不在」として扱われ、OJT対象者は別の教官に振り分けられます。\n'
        + '教官として使う場合は、優先フラグを削除してください。'
        + '教官の座席を指定したい場合は、ojt.csv の「対象座席」列をお使いください。'
      );
    });
    if (anyMentorOnSeatSide) {
      [...new Set(ojtRows.flatMap(r => r.trainees))]
        .filter(t => seatSideNames.has(t) && flagMap.has(t))
        .forEach(t => {
          // 〈ver0.5.7.3で変更〉担当教官が本日いない場合、この人は別の教官へ
          // 振り分けられる（algorithm.jsのassignMentorOjt）。それでも優先フラグが
          // 先に効くため同席はできないが、本来の担当教官の名前を出すと
          // 「その人は今日休みでは？」と読み手が混乱するため、書き分ける。
          const ownMentor = ojtIndexes && ojtIndexes.mentorOf.get(t);
          const ownMentorOnSeatSide = !!ownMentor && seatSideNames.has(ownMentor);
          const conflict = ownMentorOnSeatSide
            ? `そのため教官（${ownMentor}さん）と隣り合わせることができず、教官は担当者がいないものとして配置されます。`
            : `そのため教官と隣り合わせることができません（担当教官の${ownMentor ? `${ownMentor}さん` : '方'}が本日不在のため、本来は別の教官へ振り分けられる方です）。`;
          problems.push(
            `secret.csv：「${t}」さんは ojt.csv でOJT対象者として登録されていますが、優先フラグも設定されています。\n`
            + '優先フラグを付けた人は、他のどのルールよりも先に、1人だけで席が決まります。'
            + `${conflict}\n`
            + '優先フラグを削除してください。'
            + '同席する座席を指定したい場合は、ojt.csv の「対象座席」列をお使いください。'
          );
        });
    }

    // ---- B-10 ojt.csv：同じ人が「教官」と「OJT対象者」の両方に書かれている ----
    // 〈ver0.5.7.4で追加〉行をまたぐ兼務はこれまで検出できていなかった。
    // その人は教官としての同席で1席、OJT対象者としての同席でもう1席を占めるため、
    // 同じ方のカードが座席表に2枚できる（ver0.4.0で廃止した二重配置）。
    // 警告も出ないため、印刷して配ってから気づくことになる。
    (ojtParsed.mentorTraineeConflicts || []).forEach(({ name, traineeNames, mentorNames }) => {
      if (!attendeeNames.has(name)) return;
      const asMentor = (traineeNames || []).length > 0 ? (traineeNames || []).join('・') : '（記載なし）';
      problems.push(
        `ojt.csv：「${name}」さんが、教官（担当するOJT対象者: ${asMentor}）としても、`
        + `OJT対象者（担当教官: ${(mentorNames || []).join('・')}）としても書かれています。\n`
        + '同じ方が両方に書かれていると、教官としての同席で1席、OJT対象者としての同席でもう1席を占めるため、'
        + '同じ方のカードが座席表に2枚できてしまいます。\n'
        + 'どちらか一方の行を修正してください（OJTを卒業して教官になった場合は、対象者として書かれている行を消してください）。'
      );
    });

    // ---- B-11 ojt.csv の教官が rookie.csv にも登録されている ----
    // 〈ver0.5.7.4で追加〉B-6（教官に優先フラグ）とまったく同じ機序。
    // 新人固定席は教官・OJTより先に処理されるため、教官が先に着席してしまい、
    // 教官・OJTの処理に入る時点で「担当教官が本日不在」として扱われる。
    // 出勤しているのに不在と表示されるうえ、OJT対象者は別の教官へ振り分けられる。
    // 中断するのは、B-6と同じく「教官・OJTの処理が実際に動く日」だけに限る。
    ojtRows.forEach(r => {
      if (!rookieNames.has(r.mentorName)) return;
      if (!seatSideNames.has(r.mentorName)) return;
      if (!r.trainees.some(t => seatSideNames.has(t))) return;
      problems.push(
        `rookie.csv / ojt.csv：「${r.mentorName}」さんは ojt.csv で教官として登録されていますが、rookie.csv にも登録されています。\n`
        + '新人固定席は教官・OJTより先に処理されるため、教官として処理される時点では既に着席済みとなり、OJT対象者と隣り合わせることができません。'
        + 'この状態では「担当教官がこの座席表にいない」として扱われ、OJT対象者は別の教官に振り分けられます（実際には出勤しているため、表示とも食い違います）。\n'
        + '教官として使う場合は、rookie.csv からこの方の行を削除してください。'
        + '教官の座席を指定したい場合は、ojt.csv の「対象座席」列をお使いください。'
      );
    });

    // ---- B-7 禁止席の指定により、その日その人が座れる席がゼロになる ----
    for (const name of attendeeNames) {
      if (!secretIdx.forbiddenSeatsMap.has(name)) continue;
      if (remainingSeatKeysAfterForbidden(name, secretIdx).length > 0) continue;
      problems.push(
        `secret.csv：「${name}」さんは禁止席の指定により、座れる座席が1つも残っていません。禁止席を減らしてください。\n`
        + '（座席9番は、固定席・要サポートで名指ししたときだけ使う座席のため、残り席には数えていません）'
      );
    }

    // ---- B-9 優先フラグだけが効いてしまう行 ----
    // 種別が空欄でも優先フラグは実際に効くため、意図した固定席とは違う座席表が
    // 完成してしまう。警告は出るが、座席表を見てもその人が普通に座っているだけで、
    // 指定したつもりの席を覚えている本人以外は確認できない。
    // 〈ver0.5.7.1〉種別が正しくても対象座席などが読み取れず行ごと読み飛ばした
    // 場合も同じ状態になるため、書き出しだけ入力内容に合わせて出し分ける。
    // 「種別が書かれていません」と一律に出すと、実際には「固定」などと書いている
    // 人には内容が食い違って見えてしまうため。
    (secretParsed.priorityOnlyRows || []).forEach(({ rowNumber, name, typeCell, typeKnown }) => {
      if (!attendeeNames.has(name)) return;
      let head;
      if (!typeCell) {
        head = `「${name}」さんの行は優先フラグだけが設定されていて、種別（固定席・禁止席・要サポート）が書かれていません。`;
      } else if (!typeKnown) {
        head = `「${name}」さんの行は種別「${typeCell}」を認識できないため、優先フラグだけが設定された状態になっています。`;
      } else {
        head = `「${name}」さんの行は「${typeCell}」の指定を読み取れなかったため（同じ行について黄色のメッセージが出ています）、優先フラグだけが設定された状態になっています。`;
      }
      problems.push(
        `secret.csv ${rowNumber}行目：${head}\n`
        + '優先フラグは座席を決めるものではなく、処理の順番を早めるだけのものです。'
        + 'このままでは、この人が先にどこか空いている席に座るだけになります。\n'
        + '種別と対象座席を正しく書くか、優先フラグを消してください。'
      );
    });

    return problems;
  }

  // 画面の座席表を空に戻す。〈ver0.5.7で追加〉
  // 中断したときに前回の座席表を残しておくと、古い内容のまま印刷される恐れがある。
  function clearBoard() {
    appState.seats = initEmptyState();
    appState.early = initLeaderState();
    appState.late = initLeaderState();
    appState.overflow = [];
    appState.nightSeats = initEmptyState();
    appState.nightGL = initLeaderState();
    appState.nightSpare = initLeaderState();
    appState.nightOverflow = [];
    appState.dayExhaustive = null;
    appState.nightExhaustive = null;
    appState.dayRosterNames = null;
    appState.nightRosterNames = null;
    appState.currentDateLabel = null;
    appState.currentDate = null;
    hasRunOnce = false;   // 印刷・保存も止める
    editingLoc = null;
    els.calcTime.textContent = '';
    render();
  }

  document.getElementById('btn-run').addEventListener('click', () => {
    if (!rawText.shift) {
      // 月間シフトCSVを選んだのに弾かれた場合と、そもそも選んでいない場合とで
      // 言い方を変える。「選択してください」だけだと、選んだ本人には話が通じない。
      alert(rejectedFiles.has('shift')
        ? '月間シフトCSVは読み込めていないため、自動配置を実行できません。\n\n'
          + '内容は画面の「2. メッセージ」欄（赤色）に表示しています。修正してから、もう一度読み込んでください。'
        : '月間シフトCSVを選択してください。');
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

    // やり直しの確認は、CSVの解析・中断判定より前に行う。〈ver0.5.7.1で位置を変更〉
    // 中断すると盤面を空に戻すため（clearBoard）、この確認を中断判定の後に置くと
    // 「中断が起きるときだけ確認なしに盤面が消える」ことになり、誤って実行ボタンを
    // 押したときの取り消し手段が中断の有無で変わってしまう。
    if (hasRunOnce) {
      const ok = confirm('手動で調整した内容は失われます。自動配置をやり直しますか？');
      if (!ok) return;
    }

    // 読み込みを弾いた任意CSVがある場合の確認。〈ver0.5.7.2で追加〉
    // 弾かれたファイルは未読み込みと同じ扱いになるため、そのまま実行すると
    // 固定席も禁止席も効いていない座席表が黙って完成する。読み込み時の
    // ダイアログを閉じてしまった人にも必ず届くよう、実行の直前にもう一度出す。
    // 「今日はそのファイルなしで出す」という判断は残したいので、中断ではなく
    // OK／キャンセルの確認にとどめる。
    const rejectedOptional = ['secret', 'rookie', 'ojt'].filter(k => rejectedFiles.has(k));
    if (rejectedOptional.length > 0) {
      const lines = rejectedOptional.map(k => `・${fileLabel(k)}（${OPTIONAL_RULE_LABELS[k]}）`);
      const ok = confirm(
        `次のファイルは読み込めていないため、そのルールは効きません。\n${lines.join('\n')}\n\n`
        + 'このまま自動配置を実行しますか？\n'
        + '（キャンセルを押すと何もしません。ファイルを直して読み込み直してください）'
      );
      if (!ok) return;
    }

    // rookie.csv / secret.csv / ojt.csv はいずれも必須ではない。未読み込みの場合は
    // 該当する処理（新人固定席・固定席や禁止席・隣接禁止のチェック・教官とOJT・要サポート）を
    // 丸ごとスキップし、通常配置のみを行う
    const rookieParsed = rawText.rookie ? parseRookieRows(rawText.rookie, resolveName) : { rows: [], logs: [] };
    const secretParsed = rawText.secret
      ? parseSecretRows(rawText.secret, seatByNumber, resolveName)
      : { rows: [], logs: [], duplicateDesignatedNames: [], duplicateForbiddenNames: [], duplicateSupportNames: [], priorityOnlyRows: [] };
    const ojtParsed = rawText.ojt
      ? parseOjtRows(rawText.ojt, seatByNumber, resolveName)
      : { rows: [], logs: [], duplicateMentors: [], duplicateTrainees: [], mentorTraineeConflicts: [] };
    const ojtIndexes = buildOjtIndexes(ojtParsed.rows);
    const dayRows = rowsForDate(shiftMonthly.rows, selectedDate);
    const { opRows, leaderRows, nightOpRows, nightLeaderRows } = splitDayRows(dayRows, ojtIndexes);

    const allLogs = [...shiftMonthly.logs, ...rookieParsed.logs, ...secretParsed.logs, ...ojtParsed.logs];
    // 〈ver0.5.7.2で文言を変更〉「使用せず配置しました」と過去形で書いていたため、
    // B-1〜B-9で中断して盤面が空になった場合でも「配置した」と読めてしまっていた。
    // 中断しても成立する、時制のない言い方に統一する。
    // また、読み込みを弾いたファイル（rejectedFiles）は「はじめから渡していない」
    // 場合と区別し、黄色で「読み込めなかった」と明示する。青のお知らせのままだと、
    // 渡したつもりの利用者に事情が伝わらない。
    ['rookie', 'secret', 'ojt'].forEach(key => {
      if (rawText[key]) return;
      const label = fileLabel(key);
      if (rejectedFiles.has(key)) {
        allLogs.push({ level: 'warn', message: `${label}は読み込めなかったため、${OPTIONAL_RULE_LABELS[key]}は効いていません。ファイルを修正して読み込み直してください。` });
      } else if (key !== 'ojt') {
        // ojt.csvは「その日は使わない」運用が普通にあるため、未読み込みでも知らせない（従来どおり）
        allLogs.push({ level: 'info', message: `${label}が読み込まれていないため、${OPTIONAL_RULE_LABELS[key]}は使用しません。` });
      }
    });

    // rookie.csv に載っている人が、その日は役席・GLとして出勤する場合。〈ver0.5.7で警告へ変更〉
    // ver0.5.6では配置を実行しない扱いにしていたが撤回した。同じ人がOP勤務の日は
    // 新人ルールを効かせたいのに、役席・GL勤務の日だけ止まる。中断を解除する唯一の
    // 方法は rookie.csv の行を消すことで、そうするとOP勤務の日の新人ルールまで
    // 失われる。つまり直し方が一つに決まらないため、止めずに理由を伝える。
    // 教官として座席側へ回る役席・GL（splitDayRowsの分岐）は座席1〜15に並ぶため対象外。
    const rookieNameSet = new Set((rookieParsed.rows || []).map(r => r.name));
    [...new Set(
      [...leaderRows, ...nightLeaderRows].map(r => r.name).filter(name => rookieNameSet.has(name))
    )].forEach(name => allLogs.push({
      level: 'warn',
      message: `rookie.csv：「${name}」さんはこの日、役席・GLとして出勤するため、新人固定席は効きません（新人固定席は座席1〜15のルールで、早番・遅番エリア／夜勤GL枠には効かないため）。この日は早番・遅番エリアまたは夜勤GL枠に配置します。`,
    }));

    // 教官とOJT対象者が、日勤側と夜勤側に分かれて出勤する日。〈ver0.5.7.4で追加〉
    // 日勤と夜勤は座席表が完全に別物のため、この2人は同席できない。実際には
    // 夜勤側の別の教官へ自動的に振り分けられる（algorithm.jsのassignMentorOjt）。
    //
    // 運用上、夜勤勤務予定の方がOJTだけ日中に行うことがあり、その日は対象者も
    // 日勤側に来るためここには引っかからない。逆に、対象者が夜勤側に来ている
    // ＝勤務時間そのものが夜勤に移っているということなので、本来は
    //   ・夜勤の教官とペアを組み直す
    //   ・rookie.csv に移す（夜勤特有の運用であれば secret.csv の固定席）
    // のいずれかへ切り替える段階にある。つまりCSVの更新忘れの可能性が高い。
    // ただし「その日は振り分け先の教官で回す」という判断もあり得るため、中断はしない。
    const daySideNames = new Set([...opRows, ...leaderRows].map(r => r.name));
    const nightSideNames = new Set([...nightOpRows, ...nightLeaderRows].map(r => r.name));
    const shiftsOf = (name) => dayRows.filter(r => r.name === name);
    const timeLabelOf = (name) => shiftsOf(name).map(r => `${r.start}-${r.end}`).join(' / ') || '時間不明';
    const overlapsAny = (a, b) => a.some(x => b.some(y => x.startMin < y.endMin && y.startMin < x.endMin));
    (ojtParsed.rows || []).forEach(r => {
      r.trainees.forEach(t => {
        const split = (daySideNames.has(r.mentorName) && nightSideNames.has(t))
          || (nightSideNames.has(r.mentorName) && daySideNames.has(t));
        if (!split) return;
        const mentorSide = daySideNames.has(r.mentorName) ? '日勤' : '夜勤';
        const traineeSide = mentorSide === '日勤' ? '夜勤' : '日勤';
        const overlapped = overlapsAny(shiftsOf(r.mentorName), shiftsOf(t));
        const tail = overlapped
          ? 'お二人の勤務時間は重なっていますが、日勤側と夜勤側で座席表が分かれるため同席はできません。意図した配置かご確認ください。'
          : 'お二人の勤務時間は重なっておらず、この組み合わせでのOJTは成立しません。ojt.csvの更新忘れの可能性があります。'
            + '夜勤の教官とペアを組み直すか、rookie.csv（夜勤特有の運用であれば secret.csv の固定席）へ切り替えてください。';
        allLogs.push({
          level: 'warn',
          message: `ojt.csv：教官「${r.mentorName}」さん（${mentorSide}／${timeLabelOf(r.mentorName)}）と`
            + `OJT対象者「${t}」さん（${traineeSide}／${timeLabelOf(t)}）が、日勤側と夜勤側に分かれています。`
            + `${t}さんは${traineeSide}側の別の教官へ振り分けるか、教官なしで配置します。${tail}`,
        });
      });
    });

    // ---- 実行時に中断する条件（B-1〜B-11）をまとめて判定する ----
    const blockingProblems = collectBlockingProblems({
      selectedDate, skippedRows: shiftMonthly.skipped, secretParsed, ojtParsed, rookieParsed,
      ojtIndexes, dayRows, opRows, nightOpRows, nightLeaderRows,
    });
    if (blockingProblems.length > 0) {
      // 前回の座席表を残しておくと、古い内容のまま印刷される恐れがあるため消す
      clearBoard();
      // 中断理由を先頭に置く。メッセージ欄はスクロールするため、
      // 読み飛ばし系の警告に埋もれさせない。
      renderMessages([
        ...blockingProblems.map(message => ({ level: 'error', message })),
        ...allLogs,
      ]);
      scrollToMessages();
      // ダイアログは「実行できていないこと」に気づかせるために1回だけ出す。
      // 本文はコピーできず行数が多いと読み切れないため、詳細はメッセージ欄で読ませる。
      alert(`入力内容に問題があるため、自動配置を実行できませんでした（${blockingProblems.length}件）。\n\n`
        + '内容は画面の「2. メッセージ」欄（赤色）に表示しています。修正してから、もう一度実行してください。');
      return;
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
    //    隣接するのは許容）。「夜勤GL席」指定者にはバッジが付く（枠に選ばれたか
    //    どうかは問わない。〈ver0.5.6で変更〉）。
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
    appState.adjacentPairs = buildAdjacentPairs(secretParsed.rows);
    // 隣接禁止バッジ・教官バッジの出し分けに使う「その日の出勤者」を、日勤側・
    // 夜勤側それぞれで確定させる。〈ver0.5.4で追加〉座席に並ぶ人だけでなく、
    // 早番・遅番エリアへ回った役席・GLも出勤者として数える。
    appState.dayRosterNames = new Set([...opRows, ...leaderRows].map(r => r.name));
    appState.nightRosterNames = new Set([...nightOpRows, ...nightLeaderRows].map(r => r.name));
    appState.secretRows = secretParsed.rows;
    appState.ojtRows = ojtParsed.rows;
    appState.ojtIndexes = ojtIndexes;
    appState.rookieRows = rookieParsed.rows;
    appState.rookieIndexes = buildRookieIndexes(rookieParsed.rows);
    // 早番・遅番エリア／夜勤GL枠に回った役席・GLにもバッジ情報を付ける。〈ver0.5.6で追加〉
    // 枠にいる間はバッジを表示しないが、手動で座席へ動かした時点で表示できるようにする。
    // 上のappState.ruleIndexes / ojtIndexes / rookieIndexes を使うため、必ずその後に呼ぶこと。
    reapplyLeaderBadges();
    // 6名を超えてあふれ欄へ回った役席・GL（leaderResult.overflow）は、あふれ欄が
    // バッジ表示エリアのため、この時点でバッジ情報が必要になる。座席側から来た人は
    // 既に同じ内容が入っているため、付け直しても結果は変わらない。
    appState.overflow = appState.overflow.map(p => (p ? { ...p, ...deriveBadgeFields(p.name, p) } : p));
    appState.currentDateLabel = formatDateLabel(selectedDate);
    appState.currentDate = selectedDate;
    hasRunOnce = true;
    editingLoc = null;

    // 計算時間の計測終了。「自動配置を実行」ボタンの右側に表示する。
    const calcElapsedMs = Math.round(performance.now() - calcStartTime);
    els.calcTime.textContent = `計算時間：${calcElapsedMs}ms`;

    // 出勤状況で非表示にしたバッジのお知らせ（ver0.5.4）。appStateへの反映後に作る。
    allLogs.push(...buildBadgeVisibilityLogs());

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
        ojtGroupLetter: (idx.letterOf && idx.letterOf.get(name)) || null,
      };
    }
    if (existing) {
      return {
        isOjtMentor: !!existing.isOjtMentor,
        isOjtTrainee: !!existing.isOjtTrainee,
        ojtMentorName: existing.ojtMentorName || null,
        ojtTraineeNames: Array.isArray(existing.ojtTraineeNames) ? existing.ojtTraineeNames : [],
        ojtGroupLetter: existing.ojtGroupLetter || null,
      };
    }
    return {
      isOjtMentor: false, isOjtTrainee: false, ojtMentorName: null,
      ojtTraineeNames: [], ojtGroupLetter: null,
    };
  }

  // ---------- 出勤状況によるバッジの出し分け（ver0.5.4で追加） ----------
  // 隣接禁止バッジと教官バッジは、相手（隣接禁止のペア相手／OJT対象者）が
  // その日出勤していなければ意味を持たないため、非表示にする。
  //
  // 判定の基準は「その日出勤しているか」で固定し、「いま座席表のどこにいるか」は
  // 見ない。手動でカードを動かすたびにバッジが増減すると現場が混乱するのと、
  // メッセージ欄は自動配置・ファイル読み込みのときしか描き直されないため、
  // 配置基準にするとバッジとメッセージの内容がズレてしまうため。
  //
  // 日勤側と夜勤側は必ず別々に判定する（座席表が別物で、日勤の人と夜勤の人が
  // 隣り合ったり同席したりすることはないため）。

  // 位置（loc）が夜勤側かどうか。座席カードは seat / nightSeat / overflow /
  // nightOverflow のいずれかに置かれる。
  function isNightSideLoc(loc) {
    return !!loc && typeof loc.type === 'string' && loc.type.indexOf('night') === 0;
  }

  // その側の「出勤している人」の氏名の集合。未確定（自動配置も保存データ読み込みも
  // まだ）なら null。
  //
  // シフト上の出勤者（dayRosterNames / nightRosterNames）に加えて、いま盤面に
  // 並んでいる人も出勤者として数える。〈ver0.5.4〉✎の氏名編集で、シフトには
  // 載っていない人をカードに書き入れた場合、シフトだけで判定するとペアの片側
  // （書き入れた人）だけバッジが出て、もう片側は出ないという食い違いが起きるため。
  // 盤面から拾うのは「加える」方向だけなので、カードを動かしてもバッジが消えることはない。
  let presenceCache = null;
  function invalidatePresenceCache() { presenceCache = null; }
  function presentNamesFor(isNightSide) {
    const roster = isNightSide ? appState.nightRosterNames : appState.dayRosterNames;
    if (!roster) return null;
    if (!presenceCache) {
      const board = collectPresentNamesFromBoard();
      presenceCache = {
        day: new Set([...(appState.dayRosterNames || []), ...board.day]),
        night: new Set([...(appState.nightRosterNames || []), ...board.night]),
      };
    }
    return isNightSide ? presenceCache.night : presenceCache.day;
  }

  // 座席表に並んでいる人から出勤者を拾う（保存データを読み込んだときに使う。
  // 保存ファイルには月間シフトCSVが含まれないため、画面に並んでいる人＝その日の
  // 出勤者とみなす）。早番・遅番・夜勤GL枠・予備枠の人も出勤者として数える。
  function collectPresentNamesFromBoard() {
    const day = new Set();
    const night = new Set();
    const add = (set, p) => { if (p && p.name) set.add(p.name); };
    for (const s of SEATS) {
      for (let i = 0; i < 2; i++) {
        add(day, appState.seats[s.key][i]);
        add(night, appState.nightSeats[s.key][i]);
      }
    }
    (appState.overflow || []).forEach(p => add(day, p));
    (appState.nightOverflow || []).forEach(p => add(night, p));
    [appState.early, appState.late].forEach(area => {
      Object.keys(area || {}).forEach(k => add(day, area[k]));
    });
    [appState.nightGL, appState.nightSpare].forEach(area => {
      Object.keys(area || {}).forEach(k => add(night, area[k]));
    });
    return { day, night };
  }

  // その人の隣接禁止のペアを「相手が出勤している／していない」で仕分ける。
  // 判定材料が揃わない場合（出勤者未確定・ペア情報なし）は evaluated:false を返し、
  // 呼び出し側は従来どおりの表示に戻す。
  function splitAdjacentPairsByPresence(name, isNightSide) {
    const present = presentNamesFor(isNightSide);
    const entries = appState.adjacentPairs ? appState.adjacentPairs.get(name) : null;
    if (!present || !entries || entries.length === 0) {
      return { evaluated: false, shown: [], hidden: [] };
    }
    return {
      evaluated: true,
      shown: entries.filter(e => present.has(e.partner)),
      hidden: entries.filter(e => !present.has(e.partner)),
    };
  }

  // 隣接禁止バッジの2行目に出す記号を返す。相手が1人も出勤していない場合は
  // null（＝バッジ自体を表示しない）。
  function adjacentBadgeLabel(person, isNightSide) {
    const split = splitAdjacentPairsByPresence(person.name, isNightSide);
    if (!split.evaluated) return person.adjacentGroupLetter || '';
    if (split.shown.length === 0) return null;
    return formatAdjacentLabel(split.shown.map(e => e.letter)) || '';
  }

  // その側にOJT対象者が1名でも出勤しているか。1名もいない日は、その側の
  // 教官バッジをすべて非表示にする（担当が自分のOJT対象者かどうかは問わない。
  // 担当0名の教官でも、他の教官が不在のときの振り分け先になり得るため、
  // 「教官ごとに担当者がいるか」ではなく「全体で1名でもいるか」で判定する）。
  function hasAnyTraineePresent(isNightSide) {
    const present = presentNamesFor(isNightSide);
    const idx = appState.ojtIndexes;
    if (!present || !idx) return true; // 判定材料が無ければ従来どおり表示する
    for (const traineeName of idx.isTrainee) {
      if (present.has(traineeName)) return true;
    }
    return false;
  }

  // バッジが表示されるエリア（座席グリッドとあふれ）にいる人を、側ごとに集める。
  // メッセージの文面を作るために使う。
  function badgeAreaPeople(isNightSide) {
    const seatState = isNightSide ? appState.nightSeats : appState.seats;
    const overflowList = isNightSide ? appState.nightOverflow : appState.overflow;
    const people = [];
    for (const s of SEATS) {
      for (let i = 0; i < 2; i++) {
        if (seatState[s.key][i]) people.push(seatState[s.key][i]);
      }
    }
    (overflowList || []).forEach(p => { if (p) people.push(p); });
    return people;
  }

  // 出勤状況で非表示にしたバッジについて、メッセージ欄に出すお知らせを作る。
  // 「自動配置を実行」「保存データの読み込み」「secret.csv / ojt.csvの読み込み」の
  // タイミングで呼ぶ。
  function buildBadgeVisibilityLogs() {
    invalidatePresenceCache();
    const logs = [];
    [['日勤', false], ['夜勤', true]].forEach(([sideLabel, isNightSide]) => {
      if (!presentNamesFor(isNightSide)) return;
      const people = badgeAreaPeople(isNightSide);

      // --- 隣接禁止（全部消えた人だけでなく、一部だけ消えた人も知らせる） ---
      const notified = new Set();
      people.forEach(p => {
        if (!p.hasAdjacentRule || notified.has(p.name)) return;
        notified.add(p.name);
        const split = splitAdjacentPairsByPresence(p.name, isNightSide);
        if (!split.evaluated || split.hidden.length === 0) return;
        const absent = split.hidden.map(e => `${e.partner}さん`).join('、');
        if (split.shown.length === 0) {
          logs.push({
            level: 'info',
            message: `【${sideLabel}】${p.name}さんの隣接禁止の相手（${absent}）が本日出勤していないため、「隣禁止」バッジを表示していません。`,
          });
        } else {
          const hiddenLetters = split.hidden.map(e => e.letter).join('・');
          const shownLabel = formatAdjacentLabel(split.shown.map(e => e.letter));
          logs.push({
            level: 'info',
            message: `【${sideLabel}】${p.name}さんの隣接禁止のうち、記号${hiddenLetters}の相手（${absent}）が本日出勤していないため、「隣禁止」バッジは記号${shownLabel}のみの表示にしています。`,
          });
        }
      });

      // --- 教官（OJT対象者が1名も出勤していない日） ---
      if (appState.ojtIndexes && !hasAnyTraineePresent(isNightSide)) {
        const mentors = Array.from(new Set(people.filter(p => p.isOjtMentor).map(p => p.name)));
        if (mentors.length > 0) {
          logs.push({
            level: 'info',
            message: `【${sideLabel}】OJT対象者が本日1名も出勤していないため、教官（${mentors.join('さん、')}さん）の「教官」バッジを表示していません。`,
          });
        }
      }
    });
    return logs;
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

  // 残業の見せかた。CSVの前残業・後残業列の値（'OP' / 'GL'）に対応する。〈ver0.5.5〉
  // マーカー（背景色）は印刷されない設定のプリンタがあるため、必ず記号を併記する。
  // 記号は ※（線が細かい）と ◆（ベタ塗り）で形の系統を変えており、
  // 上付きの小さな文字でも、白黒印刷した紙の上で見分けられる。
  // 残業なし（''）の場合は null を返し、マーカーも記号も付けない。
  function otDisplay(otKind) {
    if (otKind === 'OP') return { cls: 'ot-op', mark: '※', label: 'OP残業' };
    if (otKind === 'GL') return { cls: 'ot-gl', mark: '◆', label: 'GL残業' };
    return null;
  }

  // 時刻1つ分の表示。残業（前残業/後残業）の場合はマーカー＋記号を付ける
  // （OP残業＝黄色＋「※」／GL残業＝緑色＋「◆」。色はCSS側で指定）
  function makeTimeSpan(text, otKind) {
    const span = document.createElement('span');
    span.textContent = text;
    const ot = otDisplay(otKind);
    if (ot) {
      span.classList.add('ot-time', ot.cls);
      span.title = ot.label;
      const mark = document.createElement('sup');
      mark.className = 'ot-mark';
      mark.textContent = ot.mark;
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
    // 隣接禁止・教官バッジは、その日の出勤状況で出し分ける（ver0.5.4）。
    // 詳しくは splitAdjacentPairsByPresence / hasAnyTraineePresent のコメントを参照。
    const isNightSide = isNightSideLoc(loc);
    if (person.hasAdjacentRule) {
      // 相手が1人も出勤していない場合は null が返り、バッジ自体を出さない。
      // 複数ペアがある人は、相手が出勤しているペアの記号だけが残る（A・B両方持ちで
      // Bの相手だけ出勤していれば「隣禁止 B」になる）。
      const adjacentLabel = adjacentBadgeLabel(person, isNightSide);
      if (adjacentLabel !== null) {
        badges.appendChild(makeBadge('adjacent', '隣禁止', adjacentLabel));
      }
    }
    if (person.hasNightGLDesignation) {
      badges.appendChild(makeBadge('designated', '夜勤', 'GL席'));
    }
    // 教官・OJTバッジの2行目は、ojt.csvの行ごとの記号（A・B…）。
    // 隣接禁止の記号と同じく「誰と誰の組み合わせか」を示すためのもの。
    if (person.isOjtMentor && hasAnyTraineePresent(isNightSide)) {
      badges.appendChild(makeBadge('mentor', '教官', person.ojtGroupLetter || ''));
    }
    if (person.isOjtTrainee) {
      badges.appendChild(makeBadge('mentor', 'OJT', person.ojtGroupLetter || ''));
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
      // 手入力の氏名も、姓名の間のスペースの入れ方を月間シフトCSVに合わせる。〈ver0.5.6〉
      // 「山田太郎」と入力してもCSV側が「山田 太郎」ならそちらに揃うため、
      // 固定席・新人・OJTなどのバッジやルールの再判定が効く。
      const newName = resolveName(nameInput.value);
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
      // 時刻の表記を「H:MM」に揃えてから使う。〈ver0.5.4〉
      // 「09:00」と入力されると pkey が月間シフトCSV由来の「9:00」と食い違い、
      // 同じ人・同じ勤務なのに別人と判定されて二重配置を許してしまうため。
      const start = normalizeTime(newStart);
      const end = normalizeTime(newEnd);

      // 重複判定は開始時刻も使うため、時刻の形式を確かめてから行う。〈ver0.5.3〉
      const newPkey = `${newName}|${start}`;
      if (isPersonUsedElsewhere(newPkey, loc)) {
        errorDiv.textContent = `「${newName}」（${start}開始）は既に他の座席・あふれで使われています。`;
        return;
      }

      const nameUnchanged = newName === person.name;
      const updated = {
        ...person,
        name: newName, start, end, startMin, endMin,
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
    // バッジの出し分けは盤面の顔ぶれも見るため、描画のたびに作り直す
    invalidatePresenceCache();
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
    // ②続けてその新しい案の上で禁止席だけの人とその他スタッフをランダムに
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

        // ルール1: 隣接禁止（同じ座席に2人）。〈ver0.5.7.4で追加〉
        // ADJACENCYは自分の席を含まないため、下の隣接チェックでは拾えない。
        // 隣の席がだめで同じ机ならよい、ということはないため、こちらも違反とする。
        if (occHere.length === 2 && isForbiddenPair(occHere[0].name, occHere[1].name, forbiddenPairSet)) {
          violations.push(`${label}${numberOfKey(s.key)}番の座席で、隣接禁止の${occHere[0].name}さんと${occHere[1].name}さんが同席しています`);
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
        const inDayOverflow = appState.overflow.some(p => p && p.name === name);
        const inNightOverflow = appState.nightOverflow.some(p => p && p.name === name);
        const isInOverflow = inDayOverflow || inNightOverflow;
        if (seatedAtList.length === 0 && !isInOverflow) continue; // その日出勤していない

        const badPlacement = seatedAtList.length === 0 || seatedAtList.some(o => !seatKeys.includes(o.key));
        if (badPlacement) {
          const seatList = seatKeys.map(k => `${numberOfKey(k)}番`).join(' または ');
          // 〈ver0.5.7.2で変更〉このメッセージだけ【日勤】【夜勤】が付いておらず、
          // 他の違反と並んだときにどちらのパネルの話か分からなかった。あわせて
          // 「今どこにいるか」も添える。指定席にいないことだけを伝えても、
          // 座席表とあふれ欄を目で探す手間がそのまま残るため。
          const wrongSeats = seatedAtList.filter(o => !seatKeys.includes(o.key));
          const where = [
            ...wrongSeats.map(o => `${o.label}${numberOfKey(o.key)}番の座席`),
            ...(inDayOverflow ? ['【日勤】あふれ欄'] : []),
            ...(inNightOverflow ? ['【夜勤】あふれ欄'] : []),
          ];
          // 先頭に付ける枠の名前は、実際にその人がいる側にそろえる
          const prefix = where.length > 0 ? (where[0].startsWith('【夜勤】') ? '【夜勤】' : '【日勤】') : '';
          const nowAt = where.length > 0
            ? `（現在は${where.map(w => w.replace(/^【(日勤|夜勤)】/, '')).join(' と ')}）`
            : '';
          violations.push(`${prefix}${name}さんが${label}で指定された座席（${seatList}）に配置されていません${nowAt}`);
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

    // 違反は violation（オレンジ）。座席表そのものは出来ているため、
    // 「座席表ができていない」を表す error（赤）とは区別する。〈ver0.5.7で変更〉
    const resultLogs = [
      ...violations.map(m => ({ level: 'violation', message: m })),
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
      // 残業の種別（'' / 'OP' / 'GL'）。〈ver0.5.5〉真偽値で保存すると
      // 読み込み時にOP残業とGL残業の区別が失われるため、文字列のまま保存する。
      frontOT: normalizeOTKind(p.frontOT), backOT: normalizeOTKind(p.backOT),
      role: p.role === '役席' || p.role === 'GL' ? p.role : 'OP',
      isRookie: !!p.isRookie,
      rookieRank: Number.isFinite(p.rookieRank) ? p.rookieRank : null,
      // 新人度合い〈ver0.4.19で追加〉。読み込み後に順位を付け直すために保存する
      rookieDegree: Number.isFinite(p.rookieDegree) ? p.rookieDegree : null,
      isOjtMentor: !!p.isOjtMentor,
      isOjtTrainee: !!p.isOjtTrainee,
      ojtMentorName: typeof p.ojtMentorName === 'string' ? p.ojtMentorName : null,
      ojtTraineeNames: Array.isArray(p.ojtTraineeNames) ? p.ojtTraineeNames.filter(n => typeof n === 'string') : [],
      // ojt.csvの行ごとの記号（教官・OJTバッジ2行目）。〈ver0.5.4で追加〉
      ojtGroupLetter: typeof p.ojtGroupLetter === 'string' ? p.ojtGroupLetter : null,
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
    // 過去に保存した配置には、表記を整える前の氏名（改行・二重スペースなど）が
    // 入っている可能性があるため、ここで表記を整える。〈ver0.5.6〉
    // 設定ファイル側と同じ resolveName を通すのは、保存した配置を読み込んだ直後に
    // secret.csv / ojt.csv / rookie.csv からバッジを付け直す（reapplyBadges）ため。
    // 片方だけ月間シフトCSVの表記に寄せると、そこで氏名が食い違ってバッジが
    // 黙って付かなくなる。変わるのはスペースの入れ方だけで、氏名自体は変わらない。
    const name = typeof p.name === 'string' ? resolveName(p.name) : '';
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
      // pkeyは常に「氏名|開始時刻」で作られるため、保存されている値は使わず
      // 表記を整えた氏名から作り直す。〈ver0.5.6で変更〉保存されている値をそのまま
      // 使うと、氏名だけ表記を整えた場合にpkeyと氏名が食い違い、手入力編集の
      // 二重配置チェック（isPersonUsedElsewhere）が働かなくなるため。
      pkey: `${name}|${start}`,
      // 残業の種別（'' / 'OP' / 'GL'）。〈ver0.5.5〉
      // 壊れた保存ファイルで想定外の値が入っていても、normalizeOTKind が
      // 「残業なし」に丸めるため、誤った記号が紙に出ることはない。
      frontOT: normalizeOTKind(p.frontOT), backOT: normalizeOTKind(p.backOT),
      role: p.role === '役席' || p.role === 'GL' ? p.role : 'OP',
      isRookie: !!p.isRookie,
      rookieRank: Number.isFinite(p.rookieRank) ? p.rookieRank : null,
      // 新人度合い〈ver0.4.19で追加〉。読み込み後に順位を付け直すために保存する
      rookieDegree: Number.isFinite(p.rookieDegree) ? p.rookieDegree : null,
      isOjtMentor: !!p.isOjtMentor,
      isOjtTrainee: !!p.isOjtTrainee,
      ojtMentorName: typeof p.ojtMentorName === 'string' ? p.ojtMentorName : null,
      ojtTraineeNames: Array.isArray(p.ojtTraineeNames) ? p.ojtTraineeNames.filter(n => typeof n === 'string') : [],
      // ojt.csvの行ごとの記号（教官・OJTバッジ2行目）。〈ver0.5.4で追加〉
      ojtGroupLetter: typeof p.ojtGroupLetter === 'string' ? p.ojtGroupLetter : null,
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
  // あふれ）と、早番・遅番エリア／夜勤GL枠・予備枠（reapplyLeaderBadges）。
  // 「夜勤GL席」バッジは、夜勤側にいる固定席「夜勤GL席」の指定者全員に付ける
  // （夜勤GL枠に入っている本人を含む。枠のカードにはバッジを表示しないため、
  // 実際に見えるのは座席・あふれへ動かしたときだけ。〈ver0.5.6で変更〉）。
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
    reapplyLeaderBadges();
    reapplyRookieRanks();
  }

  // 早番・遅番エリア／夜勤GL枠・予備枠にいる役席・GLにも、バッジ情報を持たせる。
  // 〈ver0.5.6で追加〉これらの枠のカード自体にはバッジを表示しない（createLeaderCard参照）が、
  // 手動で座席・あふれへ動かした時点でバッジが出るようにするため。
  // ver0.5.5までは、自動配置で最初から早番等に入った人にはバッジ情報が付いておらず、
  // 座席へ動かしてもバッジが出なかった（座席→早番→座席と動かした人だけ出ていた）。
  // 「夜勤GL席」バッジは、枠に選ばれたかどうかに関わらず、固定席「夜勤GL席」の
  // 指定者であれば付ける（他のバッジと同じく「secret.csvに指定があるか」だけで決める。
  // 〈ver0.5.6で変更〉それ以前は「枠に選ばれなかった人」を示すバッジだった）。
  // ただし日勤側の枠（早番・遅番）では付けない（夜勤専用のバッジのため）。
  function reapplyLeaderBadges() {
    const idx = appState.ruleIndexes;
    const nightGLNames = idx ? idx.nightGLDesignatedNames : new Set();
    const apply = (p, isNightSide) => (p
      ? { ...p, ...deriveBadgeFields(p.name, p), hasNightGLDesignation: isNightSide && nightGLNames.has(p.name) }
      : p);
    [[appState.early, false], [appState.late, false],
     [appState.nightGL, true], [appState.nightSpare, true]].forEach(([state, isNightSide]) => {
      if (!state) return;
      LEADER_ROWS.forEach(r => LEADER_COLS.forEach(c => {
        const k = `${r}-${c}`;
        state[k] = apply(state[k], isNightSide);
      }));
    });
  }

  // 新人バッジの順位（新人1〜7）を、いま配置されている人を対象に付け直す。
  // 〈ver0.4.19で追加〉rookie.csvが未読み込みのときは、保存データが持っている
  // 順位をそのまま使う（何もしない）。
  // 順位の決め方は algorithm.js の「新人（固定席）の対象者・順位の決定」と同じ:
  //   新人度合いが小さいほど新人として優先。同数値のときは後から出てくる人をより新人とする
  //   （自動配置時は月間シフトCSVの行順で判定するが、保存データにはその行順が
  //   残っていないため、ここでは日勤→夜勤・座席番号順の並びで代用する）。
  // 日勤・夜勤はそれぞれ別に順位を振る（自動配置時も別々に計算されるため）。
  // 〈ver0.5.5〉自動配置側が「優先フラグで先に配置された新人にもバッジを付ける」仕様に
  // なったが、この関数はもともと isRookie が立っている人を配置状況に関係なく全員
  // 拾っているため、修正は不要（結果として両者の順位が一致する）。
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
      const secretParsed = parseSecretRows(rawText.secret, seatByNumber, resolveName);
      appState.secretRows = secretParsed.rows;
      appState.ruleIndexes = buildSecretIndexes(secretParsed.rows);
      appState.adjacentGroupLetters = buildAdjacentGroups(secretParsed.rows);
      appState.adjacentPairs = buildAdjacentPairs(secretParsed.rows);
      secretNote = { level: 'info', message: '読み込み済みのsecret.csvから、違反チェック用のルールとバッジ表示を構築しました。' };
    } else {
      appState.secretRows = null;
      appState.ruleIndexes = null;
      appState.adjacentGroupLetters = null;
      appState.adjacentPairs = null;
      secretNote = { level: 'warn', message: 'secret.csvが読み込まれていないため、禁止席・隣接禁止・固定席の違反チェックとバッジ表示は使用できません。secret.csvを読み込むと自動的に有効になります。' };
    }
    // ojt.csv由来の情報（教官・OJTのバッジ、違反チェックでの同席の例外扱い）も
    // 保存ファイルには含まれていないため、同様にその場のojt.csvから作り直す
    let ojtNote = null;
    if (rawText.ojt) {
      const ojtParsed = parseOjtRows(rawText.ojt, seatByNumber, resolveName);
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
      const rookieParsed = parseRookieRows(rawText.rookie, resolveName);
      appState.rookieRows = rookieParsed.rows;
      appState.rookieIndexes = buildRookieIndexes(rookieParsed.rows);
      rookieNote = { level: 'info', message: '読み込み済みのrookie.csvから、新人のバッジ表示を構築しました。' };
    } else {
      appState.rookieRows = null;
      appState.rookieIndexes = null;
    }
    // 隣接禁止バッジ・教官バッジの出し分けに使う「その日の出勤者」を確定させる。
    // 〈ver0.5.4で追加〉保存ファイルには月間シフトCSVが含まれないため、
    // 復元した画面に並んでいる人＝その日の出勤者とみなす。
    const present = collectPresentNamesFromBoard();
    appState.dayRosterNames = present.day;
    appState.nightRosterNames = present.night;
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
    logs.push(...buildBadgeVisibilityLogs());
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

  // 残業（前残業/後残業）の時刻表示。OP残業＝黄色の背景＋「※」、
  // GL残業＝緑色の背景＋「◆」で示す
  // （背景色が印刷されない設定でも記号は必ず印刷される。背景色自体はCSS側で指定）
  function printTimeSpan(text, otKind) {
    const ot = otDisplay(otKind);
    if (!ot) return `<span class="pt">${escapeHtml(text)}</span>`;
    return `<span class="pt ot ${ot.cls}">${escapeHtml(text)}<sup class="ot-mark">${ot.mark}</sup></span>`;
  }

  // その紙に実際に出ている残業の種別（'OP' / 'GL'）を集める。凡例の出し分けに使う。
  function collectOTKinds(persons) {
    const kinds = new Set();
    persons.forEach(p => {
      if (!p) return;
      if (otDisplay(p.frontOT)) kinds.add(p.frontOT);
      if (otDisplay(p.backOT)) kinds.add(p.backOT);
    });
    return kinds;
  }

  // 印刷ページの凡例。その紙に出ている記号だけを載せ、残業が1件も無ければ何も出さない。
  // 座席表そのものには記号1文字しか出さないため、意味はここで補う。
  function otLegendHtml(kinds) {
    const parts = [];
    if (kinds.has('OP')) parts.push('※…OP残業');
    if (kinds.has('GL')) parts.push('◆…GL残業');
    if (parts.length === 0) return '';
    return `<div class="print-legend">${parts.join('／')}（出勤時刻＝前残業／退勤時刻＝後残業）</div>`;
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

    // 残業の記号が1件でもあれば、意味を説明する凡例を表示する。
    // ページごと・種別ごとに判定するため、OP残業しかいない日に「◆…GL残業」は出ない。
    const dayLegendHtml = otLegendHtml(collectOTKinds([]
      .concat(...SEATS.map(s => appState.seats[s.key] || []))
      .concat(Object.values(appState.early))
      .concat(Object.values(appState.late))));

    // --- 2ページ目: 夜勤 ---
    // 左＝見出しなしの予備枠（通常は空。手動で置いた場合はその内容を印刷）、右＝夜勤GL枠
    const nightLeaderHtml = '<div class="print-leader-section">'
      + printLeaderColumnHtml(appState.nightSpare, '')
      + printLeaderColumnHtml(appState.nightGL, '夜勤GL')
      + '</div>';
    const nightGridHtml = printSeatGridHtml(appState.nightSeats);
    const nightOverflowHtml = printOverflowHtml(appState.nightOverflow);

    const nightLegendHtml = otLegendHtml(collectOTKinds([]
      .concat(...SEATS.map(s => appState.nightSeats[s.key] || []))
      .concat(Object.values(appState.nightGL))
      .concat(Object.values(appState.nightSpare))));

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
  /* 残業の目印: 画面・印刷（プレビュー含む）どちらも塗りつぶす。
     OP残業＝黄色、GL残業＝緑色。
     以前は印刷時のみ薄いグレーに切り替える案（Excelの「12.5%灰色」相当）を
     試したが、環境によって印刷に反映されなかったため、色を統一している。
     背景色が出ないプリンタでも見分けられるよう、※（OP残業）／◆（GL残業）の
     記号を必ず併記している（printTimeSpan を参照）。 */
  .print-time .pt.ot, .print-leader-time .pt.ot {
    font-weight:700; padding:0 0.6mm; border-radius:0.3mm;
  }
  .print-time .pt.ot-op, .print-leader-time .pt.ot-op { background-color:#FFF3B0; }
  .print-time .pt.ot-gl, .print-leader-time .pt.ot-gl { background-color:#C8EFD0; }
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
    // 座席表ができていないときは印刷させない。〈ver0.5.7で追加〉
    // 中断すると盤面を空に戻すため、そのまま印刷すると白紙の座席表が出てしまう。
    if (!hasRunOnce) {
      alert('印刷できる座席表がありません。先に「自動配置を実行」するか、保存した配置を読み込んでください。');
      return;
    }
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
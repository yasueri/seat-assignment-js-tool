// ============================================================
// algorithm.js
// 座席の定義と、新人固定席 → 隣接禁止・禁止席対象者 → その他スタッフ
// の順で座席を割り当てるアルゴリズムを担当する。隣接禁止・禁止席対象者
// の全探索backtrack（■2。旧algorithmExhaustive.js。
// ver4.9でこのファイルに統合）も含む。
// CSVの形式やDOMには一切依存しない（テストしやすくするため）。
// 他ファイルからは window.SeatTool.algorithm 経由で利用する。
// ============================================================
window.SeatTool = window.SeatTool || {};

window.SeatTool.algorithm = (function () {
  "use strict";

  // ---------- 座席の定義（全15席、(4,4)は存在しない） ----------
  const SEATS = [];
  for (let row = 1; row <= 4; row++) {
    const maxCol = row === 4 ? 3 : 4;
    for (let col = 1; col <= maxCol; col++) {
      SEATS.push({ row, col, key: `${row}-${col}` });
    }
  }

  function seatExists(row, col) {
    return SEATS.some(s => s.row === row && s.col === col);
  }

  // ---------- 座席番号（表示用。1列目を上から下へ①②③④、2列目⑤⑥⑦⑧ … の順） ----------
  (function assignSeatNumbers() {
    let n = 0;
    for (let col = 1; col <= 4; col++) {
      for (let row = 1; row <= 4; row++) {
        const seat = SEATS.find(s => s.row === row && s.col === col);
        if (seat) { n++; seat.number = n; }
      }
    }
  })();
  const SEAT_BY_NUMBER = {};
  const NUMBER_BY_KEY = {};
  for (const s of SEATS) { SEAT_BY_NUMBER[s.number] = s; NUMBER_BY_KEY[s.key] = s.number; }

  // 座席番号順（1〜15）に並べた配列。deterministic=true（■2の「その他」決定的配置や
  // 「次の案」切り替え時の安定表示に使用）のとき、shuffleの代わりにこの順序を使う。
  const SEATS_IN_NUMBER_ORDER = SEATS.slice().sort((a, b) => a.number - b.number);

  // 座席9番は運用上の理由により、通常の自動配置（新人固定席・優先順位の低い人から
  // 埋めていく通常探索・その他スタッフ・全探索backtrackでの空席探索など、CSVで
  // 明示指定されていない一般的な候補選びすべて）では使用しない。ただし、
  // secret.csvの固定席・要サポート、ojt.csvの対象座席で座席9番が明示的に
  // 指定されていた場合は例外的に配置する（下記 noteSeat9IfUsed でメッセージを出す）。
  // canPlace / canPlaceSharedSeat の2箇所（全ての座席選定処理が最終的に通る共通の
  // ゲート関数）で allowSeat9 引数により切り替えており、呼び出し元が
  // 「本人の明示指定に由来する候補リストかどうか」に応じて true/false を渡す。
  // 手動でのドラッグ＆ドロップ操作はこのチェックを経由しないため、手動での
  // 座席9番への配置は常に可能。
  const AUTO_PLACEMENT_EXCLUDED_SEAT_NUMBERS = new Set([9]);

  // 座席9番は通常自動配置の対象外だが、固定席・要サポート・教官/OJT同席で明示的に
  // 座席9番が指定されていた場合はそのまま配置する（新人固定席は常に座席5〜8のみを
  // 使うため、座席9番が候補になることは構造上ない）。実際に座席9番へ配置された
  // 場合は、意図した配置か確認しやすいようメッセージで知らせる。
  function noteSeat9IfUsed(seat, personName, ruleLabel, logs) {
    if (seat && seat.number === 9) {
      logs.push({
        level: 'info',
        message: `通常、座席9番には配置しませんが、${personName}さんは${ruleLabel}で指定されていたため座席9番に配置しました。`,
      });
    }
  }

  function seatByNumber(n) { return SEAT_BY_NUMBER[n] || null; }
  function numberOfKey(key) { return NUMBER_BY_KEY[key] || null; }
  function numberOfSeat(row, col) { return numberOfKey(`${row}-${col}`); }

  function isAdjacentSeat(a, b) {
    return a.col === b.col && Math.abs(a.row - b.row) === 1;
  }

  // 座席キー -> 同列で隣接する座席キーの一覧（ルール1判定に使用）
  const ADJACENCY = {};
  for (const s of SEATS) {
    ADJACENCY[s.key] = SEATS.filter(t => t.key !== s.key && isAdjacentSeat(s, t)).map(t => t.key);
  }

  // ---------- 補助関数 ----------
  function overlaps(a, b) {
    return a.startMin < b.endMin && b.startMin < a.endMin;
  }

  function hasExactBoundaryMatch(person, occupants) {
    if (occupants.length !== 1) return false;
    const o = occupants[0];
    return o.endMin === person.startMin || o.startMin === person.endMin;
  }

  function shuffle(arr) {
    const a = arr.slice();
    for (let i = a.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [a[i], a[j]] = [a[j], a[i]];
    }
    return a;
  }

  function pairKey(a, b) { return [a, b].sort().join('|'); }

  function slotOccupants(seatSlots) { return seatSlots.filter(Boolean); }

  // secret.csvの行から、判定用のインデックスを組み立てる。
  // 禁止席・固定席・要サポートは1人につき1行（対象座席はスペース区切りで複数指定）で
  // 書く仕様のため、ここではその1行から生じた複数のseatKeyを配列にまとめるだけでよい。
  function buildSecretIndexes(secretRows) {
    const forbiddenPairSet = new Set();
    const forbiddenSeatSet = new Set();
    const forbiddenSeatsMap = new Map(); // name -> [seatKey, ...]（バッジ表示用）
    const designatedSeatsMap = new Map(); // name -> [seatKey, ...]
    const supportSeatsMap = new Map(); // name -> [seatKey, ...]（要サポート）
    const adjacentRuleNames = new Set();
    const forbiddenSeatRuleNames = new Set();
    const designatedNames = new Set();
    const supportNames = new Set(); // 要サポートバッジ表示用
    const nightGLDesignatedNames = new Set(); // 固定席「夜勤GL席」の対象者名
    const priorityFlagMap = new Map(); // name -> 優先フラグの数値（複数行ある場合は最小値）

    for (const r of secretRows) {
      if (r.type === 'adjacent_forbidden') {
        forbiddenPairSet.add(pairKey(r.name1, r.name2));
        adjacentRuleNames.add(r.name1);
        adjacentRuleNames.add(r.name2);
      } else if (r.type === 'seat_forbidden') {
        forbiddenSeatSet.add(`${r.name}|${r.row}-${r.col}`);
        forbiddenSeatRuleNames.add(r.name);
        if (!forbiddenSeatsMap.has(r.name)) forbiddenSeatsMap.set(r.name, []);
        forbiddenSeatsMap.get(r.name).push(`${r.row}-${r.col}`);
      } else if (r.type === 'seat_designated') {
        if (!designatedSeatsMap.has(r.name)) designatedSeatsMap.set(r.name, []);
        designatedSeatsMap.get(r.name).push(`${r.row}-${r.col}`);
        // silent=true は「secret.csvには由来しない、ツール内部の強制配置」用の印。
        // designatedSeatsMap には加えて座席への強制配置自体は行うが、
        // designatedNames には加えないため「固定席」バッジは表示されない
        // （夜勤の役席・GLが2名以上のとき座席10へ回る人の配置に使用）。
        if (!r.silent) designatedNames.add(r.name);
      } else if (r.type === 'seat_support') {
        if (!supportSeatsMap.has(r.name)) supportSeatsMap.set(r.name, []);
        supportSeatsMap.get(r.name).push(`${r.row}-${r.col}`);
        supportNames.add(r.name);
      } else if (r.type === 'night_gl_designated') {
        nightGLDesignatedNames.add(r.name);
      } else if (r.type === 'priority_flag') {
        const existing = priorityFlagMap.get(r.name);
        if (existing === undefined || r.flag < existing) priorityFlagMap.set(r.name, r.flag);
      }
    }

    // 優先処理・バッジ表示のために使う「何かしらsecret.csvに載っている人」の集合
    const priorityNames = new Set([...adjacentRuleNames, ...forbiddenSeatRuleNames, ...designatedNames]);

    return {
      forbiddenPairSet, forbiddenSeatSet, forbiddenSeatsMap, designatedSeatsMap,
      supportSeatsMap, supportNames,
      adjacentRuleNames, forbiddenSeatRuleNames, designatedNames, priorityNames,
      nightGLDesignatedNames, priorityFlagMap,
    };
  }

  function isForbiddenPair(a, b, forbiddenPairSet) { return forbiddenPairSet.has(pairKey(a, b)); }

  // 隣接禁止の「ペア」ごとにA・B・C…の記号を割り当て、各対象者には
  // 自分が属するペアの記号を並べたラベルを付ける（バッジ表示用）。
  // 例: 短一-短三＝ペアA、短二-短三＝ペアB
  //     → 短一:「A」、短二:「B」、短三:「AB」（AとBの両方に属する）
  // 同じ記号を持つ人同士が「隣に座ってはいけない相手」を表す。
  // 1人が4ペア以上に属する場合は記号を並べず「4以上」と表示する。
  // ペアはsecret.csvの記載順に記号を振る（同じペアの重複行は1つと数える）。
  function buildAdjacentGroups(secretRows) {
    const seenPairs = new Set();
    const pairs = [];
    secretRows.filter(r => r.type === 'adjacent_forbidden').forEach(r => {
      const key = pairKey(r.name1, r.name2);
      if (seenPairs.has(key)) return;
      seenPairs.add(key);
      pairs.push([r.name1, r.name2]);
    });

    const letters = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
    // 27ペア目以降は AA, AB, … と2文字になる（実運用上まず発生しない想定）
    const letterOf = (index) => {
      let s = '';
      let i = index + 1;
      while (i > 0) { i -= 1; s = letters[i % 26] + s; i = Math.floor(i / 26); }
      return s;
    };

    const nameToLetters = new Map();
    pairs.forEach(([a, b], i) => {
      const letter = letterOf(i);
      [a, b].forEach(name => {
        if (!nameToLetters.has(name)) nameToLetters.set(name, []);
        nameToLetters.get(name).push(letter);
      });
    });

    const nameToLabel = new Map();
    for (const [name, ls] of nameToLetters.entries()) {
      nameToLabel.set(name, ls.length >= 4 ? '4以上' : ls.join(''));
    }
    return nameToLabel; // name -> 'A' | 'AB' | '4以上' | ...
  }

  // ============================================================
  // 教官・OJT（ojt.csv、ver4.7で追加）
  // ・優先順位は新人固定席・固定席の次（新人→固定席→教官・OJTの順）
  // ・教官1名につきOJT対象者は最大2名。教官とOJT一人目は同じ座席に同席する
  //   （この場合に限り、勤務時間が重なっていても同席を許可する＝通常「1座席2名
  //   までは時間が重ならない場合のみ」という制約の例外）
  // ・OJT二人目がいる場合は、教官+OJT一人目の座席とは別に、OJT二人目だけが
  //   座る座席をペアで探す（OJT二人目は他の誰かと時間が重なることは許可しない＝通常どおり）
  // ・教官が本日不在の場合、OJT対象者は同席する相手がいないためお1人で配置する
  //   （対象座席の優先順のみ流用。手動での臨時教官の割り当てが必要な旨をログに残す）
  // ・複数の教官がいる場合、教官1名・OJT2名（ペア配置）のケースを先に配置する。
  //   教官1名・OJT1名側は、既定順（15→12→8→4→他）で空きが見つからなかった場合、
  //   既に配置済みの教官1名・OJT2名の座席（教官+OJT一人目側・OJT二人目側の両方）と
  //   同列で1つ前（行が1つ小さい側）の座席が空いていないかを追加で試す
  //   （例: 教官+OJT2名が12・8に座っていれば、11・7が空いていないか探す）。
  //   それでも見つからなければ、通常どおり他の空席から探す。
  // ============================================================

  // 単独配置（教官+OJT一人目）の既定候補順。ojt.csvの対象座席で指定した座席が
  // これより前に来る（例:「12」なら 12,15,8,4 の順になる）
  const OJT_DEFAULT_SINGLE_ORDER = [15, 12, 8, 4];

  // OJT二人目がいる場合のペア候補（[教官が座る側, OJT二人目が座る側]）。
  // 対象座席から算出した単独順で12が15より先に来る教官は[12,8]を先に、
  // そうでなければ[15,14]を先に試す。以降はどちらの教官でも共通の並び
  // （フォールバック）。この並びはレイアウトに紐づく固定値のためojt.csvには
  // 持たせずここに定数として置く（readme.txtにも同じ並びを記載する）。
  // 末尾の(10,9)は座席9番が自動配置の対象外のため実際には使われることが
  // なかったため削除した（ver4.10）。
  const OJT_FALLBACK_PAIR_TAIL = [
    [12, 11], [8, 7], [4, 3], [11, 7], [11, 10], [7, 6],
    [3, 2], [14, 13], [10, 6], [6, 5], [2, 1],
  ];

  // ojt.csvの行から、判定・配置に使うインデックスを組み立てる
  function buildOjtIndexes(ojtRows) {
    const mentorOf = new Map();     // OJT対象者名 -> 教官名
    const traineesOf = new Map();   // 教官名 -> [OJT対象者名, ...]（ojt.csv記載順）
    const seatOrderOf = new Map();  // 教官名 -> [座席番号, ...]（対象座席。空配列=既定順のみ）
    const isMentor = new Set();
    const isTrainee = new Set();
    (ojtRows || []).forEach(r => {
      isMentor.add(r.mentorName);
      traineesOf.set(r.mentorName, r.trainees);
      seatOrderOf.set(r.mentorName, r.seatOrder || []);
      r.trainees.forEach(t => { mentorOf.set(t, r.mentorName); isTrainee.add(t); });
    });
    return { mentorOf, traineesOf, seatOrderOf, isMentor, isTrainee };
  }

  // 対象座席（override配列）から、単独配置時の座席番号の優先順を作る
  // （overrideに書かれた座席を先頭にし、残りは既定順のまま続ける）
  function ojtSingleSeatOrder(seatOrder) {
    const overridden = seatOrder || [];
    const rest = OJT_DEFAULT_SINGLE_ORDER.filter(n => !overridden.includes(n));
    return [...overridden, ...rest];
  }

  // 単独順（ojtSingleSeatOrderの戻り値）から、ペア配置時にどちらの主要ペアを
  // 先に試すかを決め、[主要ペア, 主要ペア, ...共通フォールバック] を返す
  function ojtPairOrder(singleOrder) {
    const pos12 = singleOrder.indexOf(12);
    const pos15 = singleOrder.indexOf(15);
    const primaries = (pos12 < pos15) ? [[12, 8], [15, 14]] : [[15, 14], [12, 8]];
    return [...primaries, ...OJT_FALLBACK_PAIR_TAIL];
  }

  // 教官1名・OJT2名の配置で使った座席番号（教官+OJT一人目側／OJT二人目側の両方）から、
  // 「同列で1つ前（行が1つ小さい側）」の座席番号を集める。教官1名・OJT1名のペアが
  // 既定順（15→12→8→4）で空きを見つけられなかった場合の追加候補として使う
  // （例: 教官+OJT2名が12・8に座っていれば11・7を候補にする）。行1（各列の最上段）の
  // 座席にはこれより上が存在しないため対象外とする。
  function ojtAdjacentUpCandidates(seatNumbers) {
    const result = [];
    const seen = new Set();
    for (const num of seatNumbers) {
      const seat = seatByNumber(num);
      if (!seat || seat.row <= 1) continue;
      const up = SEATS.find(s => s.row === seat.row - 1 && s.col === seat.col);
      if (up && !seen.has(up.number)) { seen.add(up.number); result.push(up.number); }
    }
    return result;
  }

  // 教官・OJT一人目が同席する1座席分の配置可否。2枠とも空である座席のみを
  // 対象とする（同時刻の2人がまるごと入るため）。通常のcanPlaceと違い、
  // 時間の重なりはチェックしない（教官・OJTの同席は時間重複の例外として扱う）。
  // 禁止席・隣接禁止は通常どおり両者に適用する。
  function canPlaceSharedSeat(personA, personB, seat, state, forbiddenSeatSet, forbiddenPairSet, allowSeat9) {
    if (!allowSeat9 && AUTO_PLACEMENT_EXCLUDED_SEAT_NUMBERS.has(seat.number)) return false;
    if (slotOccupants(state[seat.key]).length > 0) return false;
    if (forbiddenSeatSet.has(`${personA.name}|${seat.key}`)) return false;
    if (forbiddenSeatSet.has(`${personB.name}|${seat.key}`)) return false;
    for (const adjKey of ADJACENCY[seat.key]) {
      for (const occ of slotOccupants(state[adjKey])) {
        if (isForbiddenPair(personA.name, occ.name, forbiddenPairSet)) return false;
        if (isForbiddenPair(personB.name, occ.name, forbiddenPairSet)) return false;
      }
    }
    return true;
  }

  function seatPersonPair(state, seatKey, personA, personB) {
    state[seatKey][0] = personA;
    state[seatKey][1] = personB;
  }

  // OJT対象者を1人だけ座席に配置する場合、常に座席の「二人目」（スロット1）に
  // 配置する（教官が同席する場合はスロット0が教官・スロット1がOJT一人目となるため、
  // 教官が不在で1人だけの場合や、OJT二人目だけの座席でも同じスロット1を使うことで、
  // 「OJT対象者は常に座席の二人目」という表示位置を統一する）。
  // 万一スロット1が既に埋まっている場合（同じ座席に時間の異なる別のOJT対象者が
  // 既に入っている等、稀なケース）はスロット0にフォールバックする。
  function seatOjtTraineeAlone(state, seatKey, person) {
    const arr = state[seatKey];
    if (!arr[1]) arr[1] = person;
    else arr[0] = person;
  }

  // 座席番号の優先順リストから、この人が配置できる最初の座席を探す（教官不在で
  // OJT対象者を1人で配置する場合に使用）。優先順を厳密に守るため、
  // findSeatAmongCandidatesのようなシャッフルはしない。
  // ここに渡される候補は必ず「ojt.csvの対象座席で明示指定された座席（＋既定順の残り）」
  // であり、座席9番は明示指定されない限りこの並びに現れないため、
  // 座席9番の除外チェックはここでは行わない（明示指定があれば配置してよい）。
  function findSeatInOrder(seatNumbers, person, state, forbiddenSeatSet, forbiddenPairSet) {
    for (const num of seatNumbers) {
      const seat = seatByNumber(num);
      if (seat && canPlace(person, seat, state, forbiddenSeatSet, forbiddenPairSet, true)) return seat;
    }
    return null;
  }

  // 座席番号の優先順リストから、教官+OJT一人目が同席できる最初の座席を探す
  // （優先順を厳密に守るため、findSeatAmongCandidatesのようなシャッフルはしない）。
  // allowSeat9: 呼び出し元の候補リストがojt.csvの明示指定に由来する場合はtrueを渡す
  // （「同列で1つ前」の自動算出候補など、明示指定に由来しない候補リストではfalse＝除外のまま）。
  function findSharedSeatInOrder(seatNumbers, personA, personB, state, forbiddenSeatSet, forbiddenPairSet, allowSeat9) {
    for (const num of seatNumbers) {
      const seat = seatByNumber(num);
      if (seat && canPlaceSharedSeat(personA, personB, seat, state, forbiddenSeatSet, forbiddenPairSet, allowSeat9)) return seat;
    }
    return null;
  }

  // 「他」用: 優先順リストにない座席も含め、全15席から探す（特に優先順位は
  // 設けないため、他の探索と同様にランダムな順で最初に見つかったものを使う）
  function findSharedSeatAnywhere(personA, personB, state, forbiddenSeatSet, forbiddenPairSet) {
    return shuffle(SEATS).find(seat => canPlaceSharedSeat(personA, personB, seat, state, forbiddenSeatSet, forbiddenPairSet)) || null;
  }

  // ペア候補（[教官側座席番号, OJT二人目側座席番号]の配列）から、両方が配置可能な
  // 最初の組を探す。教官側は同席（canPlaceSharedSeat）、OJT二人目側は通常の
  // canPlace（他の誰かと時間が重ならなければ同席可）で判定する。
  // pairOrderはシステム既定の候補配列（primaries・OJT_FALLBACK_PAIR_TAIL）に
  // 由来するため、allowSeat9=trueを渡している。現状はどちらの配列にも座席9番を
  // 含まないため挙動に変化はないが、将来これらの配列に座席9番を含むペアを
  // 追加した場合に備えた措置。
  function findOjtPairInOrder(pairOrder, mentor, trainee1, trainee2, state, forbiddenSeatSet, forbiddenPairSet) {
    for (const [numA, numB] of pairOrder) {
      const seatA = seatByNumber(numA);
      const seatB = seatByNumber(numB);
      if (!seatA || !seatB) continue;
      if (canPlaceSharedSeat(mentor, trainee1, seatA, state, forbiddenSeatSet, forbiddenPairSet, true)
        && canPlace(trainee2, seatB, state, forbiddenSeatSet, forbiddenPairSet, true)) {
        return { seatA, seatB };
      }
    }
    return null;
  }

  /**
   * 教官・OJTの配置本体。assignSeats内で固定席の直後・新人固定席の前に呼び出す。
   * byName: その日出勤している全員の 氏名 -> オブジェクト のMap
   * ojtIndexes: buildOjtIndexes() の戻り値（ojt.csv未読み込み等でnullなら何もしない）
   * state / forbiddenSeatSet / forbiddenPairSet / overflow / placedNames / logs:
   *   assignSeats内のものをそのまま渡す
   *
   * 担当教官が本日不在（または固定席等で既に配置済みで教官・OJTの処理に使えない）の場合、
   * そのOJT対象者は、出勤していて枠に空きがある他の教官へ自動的に振り分ける
   * （教官は同時に最大2名まで担当できるため、既存の担当人数＋振り分け対象の人数が
   * 2名を超えない教官を、ojt.csvの記載順で探す）。振り分け先が見つかった場合、
   * 座席の優先順はその「振り分け先の教官」自身のojt.csv設定（対象座席）を使う。
   * 振り分け先が見つからない場合（教官が全員不在、または全員の枠が埋まっている）は、
   * 従来どおりOJT対象者をお1人で配置し、手動での臨時教官割り当てを促す。
   */
  function assignMentorOjt(byName, ojtIndexes, state, forbiddenSeatSet, forbiddenPairSet, overflow, placedNames, logs) {
    if (!ojtIndexes) return;

    // ---- 1st pass: 教官ごとの出勤状況と、本人が今日担当するOJT対象者（本人分のみ）を確定する ----
    const entries = Array.from(ojtIndexes.traineesOf.keys()).map(mentorName => {
      const mentor = byName.get(mentorName) || null;
      // 教官自身が既に他の優先ルール（固定席）で配置済みの場合は、教官・OJTの
      // 特別な同席処理には使えないため、不在の教官と同様に扱う
      const available = !!mentor && !placedNames.has(mentorName);
      const ownTrainees = (ojtIndexes.traineesOf.get(mentorName) || []).filter(t => byName.has(t) && !placedNames.has(t));
      return { mentorName, mentor, available, ownTrainees };
    });

    // ---- 2nd pass: 教官が不在（または利用不可）の行から生じる「担当者不在の
    //      OJT対象者」を、出勤していて枠に空きがある他の教官へ自動的に振り分ける ----
    const effectiveTrainees = new Map(); // 教官名 -> 今日実際に担当するOJT対象者名（本人分＋振り分け分）
    entries.forEach(e => { if (e.available) effectiveTrainees.set(e.mentorName, [...e.ownTrainees]); });

    entries.filter(e => !e.available && e.ownTrainees.length > 0).forEach(orphanGroup => {
      const backup = entries.find(e => e.available
        && (effectiveTrainees.get(e.mentorName).length + orphanGroup.ownTrainees.length) <= 2);
      if (backup) {
        effectiveTrainees.get(backup.mentorName).push(...orphanGroup.ownTrainees);
        logs.push({
          level: 'info',
          message: `${orphanGroup.ownTrainees.join('さん、')}さんの担当教官（${orphanGroup.mentorName}さん）が本日不在のため、${backup.mentorName}さんが代わりに担当します。`,
        });
        return;
      }
      // 代わりに担当できる教官が見つからない（教官が全員不在、または全員の枠が
      // 埋まっている）ため、対象座席の優先順のみ使ってお1人で配置する
      // （手動での臨時教官割り当てが前提）。
      const singleOrder = ojtSingleSeatOrder(ojtIndexes.seatOrderOf.get(orphanGroup.mentorName) || []);
      orphanGroup.ownTrainees.forEach(traineeName => {
        const trainee = byName.get(traineeName);
        const seat = findSeatInOrder(singleOrder, trainee, state, forbiddenSeatSet, forbiddenPairSet)
          || findSeat(trainee, state, forbiddenSeatSet, forbiddenPairSet, false);
        if (seat) {
          seatOjtTraineeAlone(state, seat.key, trainee);
          noteSeat9IfUsed(seat, traineeName, '教官・OJT同席（対象座席）', logs);
        } else {
          logs.push({ level: 'error', showDialog: true, message: `${traineeName}さんを配置できません。配置ルールに矛盾がある可能性があります。` });
          overflow.push(trainee);
        }
        placedNames.add(traineeName);
      });
      logs.push({ level: 'warn', message: `${orphanGroup.ownTrainees.join('さん、')}さんの担当教官（${orphanGroup.mentorName}さん）が本日不在で、代わりに担当できる教官も見つからなかったため、OJT対象者のみで配置しました。手動で臨時教官を割り当ててください。` });
    });

    // ---- 3rd pass: 出勤している教官ごとに、実際に担当するOJT対象者
    //      （本人分＋振り分けで引き受けた分。座席の優先順は教官自身のojt.csv設定を使う）で
    //      座席配置を行う。
    //      教官1名・OJT2名（ペア配置）のケースを先に配置し、その座席番号を
    //      教官1名・OJT1名側の追加フォールバック（同列1つ前の座席）に使う。 ----
    const twoTraineeEntries = entries.filter(e => e.available && (effectiveTrainees.get(e.mentorName) || []).length === 2);
    const oneTraineeEntries = entries.filter(e => e.available && (effectiveTrainees.get(e.mentorName) || []).length === 1);
    const orderedEntries = [...twoTraineeEntries, ...oneTraineeEntries];
    const pairSeatNumbers = []; // 教官1名・OJT2名の配置で使われた座席番号（教官+OJT一人目側／OJT二人目側の両方）

    for (const e of orderedEntries) {
      const traineeNames = effectiveTrainees.get(e.mentorName) || [];
      const mentor = e.mentor;
      const mentorName = e.mentorName;
      const seatOrder = ojtIndexes.seatOrderOf.get(mentorName) || [];
      const singleOrder = ojtSingleSeatOrder(seatOrder);

      if (traineeNames.length === 1) {
        const trainee = byName.get(traineeNames[0]);
        // 既定順（15→12→8→4→他）で見つからなければ、既に配置済みの教官1名・OJT2名の
        // 座席の同列1つ前を追加候補として試す
        const upCandidates = ojtAdjacentUpCandidates(pairSeatNumbers);
        const seat = findSharedSeatInOrder(singleOrder, mentor, trainee, state, forbiddenSeatSet, forbiddenPairSet, true)
          || (upCandidates.length > 0 ? findSharedSeatInOrder(upCandidates, mentor, trainee, state, forbiddenSeatSet, forbiddenPairSet) : null)
          || findSharedSeatAnywhere(mentor, trainee, state, forbiddenSeatSet, forbiddenPairSet);
        if (seat) {
          seatPersonPair(state, seat.key, mentor, trainee);
          placedNames.add(mentorName);
          placedNames.add(traineeNames[0]);
          noteSeat9IfUsed(seat, mentorName, '教官・OJT同席（対象座席）', logs);
        } else {
          // 15席すべて埋まっている等、極めて稀なケース。教官・OJTをそれぞれ独立に配置する
          logs.push({ level: 'warn', message: `${mentorName}さんと${traineeNames[0]}さんを同席させる座席が見つからなかったため、それぞれ個別に配置しました。` });
          placeOrOverflow(mentor, state, forbiddenSeatSet, forbiddenPairSet, overflow, placedNames, logs, false, false);
          placeOrOverflow(trainee, state, forbiddenSeatSet, forbiddenPairSet, overflow, placedNames, logs, false, false);
        }
      } else if (traineeNames.length === 2) {
        const trainee1 = byName.get(traineeNames[0]);
        const trainee2 = byName.get(traineeNames[1]);
        const pairOrder = ojtPairOrder(singleOrder);
        const pair = findOjtPairInOrder(pairOrder, mentor, trainee1, trainee2, state, forbiddenSeatSet, forbiddenPairSet);
        if (pair) {
          seatPersonPair(state, pair.seatA.key, mentor, trainee1);
          seatOjtTraineeAlone(state, pair.seatB.key, trainee2);
          placedNames.add(mentorName);
          placedNames.add(traineeNames[0]);
          placedNames.add(traineeNames[1]);
          pairSeatNumbers.push(pair.seatA.number, pair.seatB.number);
          noteSeat9IfUsed(pair.seatA, mentorName, '教官・OJT同席（対象座席）', logs);
          noteSeat9IfUsed(pair.seatB, traineeNames[1], '教官・OJT同席（対象座席）', logs);
        } else {
          // ペア候補（主要2つ＋共通フォールバック12個）がすべて埋まっていた場合は、
          // 教官・OJT二人をまとめて同席させることにこだわらず、通常の空席探索に切り替える
          logs.push({ level: 'warn', message: `${mentorName}さん・${traineeNames.join('さん、')}さんのペア席の候補がすべて埋まっていたため、通常の空席探索で個別に配置しました。` });
          placeOrOverflow(mentor, state, forbiddenSeatSet, forbiddenPairSet, overflow, placedNames, logs, false, false);
          placeOrOverflow(trainee1, state, forbiddenSeatSet, forbiddenPairSet, overflow, placedNames, logs, false, false);
          placeOrOverflow(trainee2, state, forbiddenSeatSet, forbiddenPairSet, overflow, placedNames, logs, false, false);
        }
      }
    }
  }

  // 座席1つに対して、この人を配置してよいか（容量・重複・ルール1・ルール2）
  // 注: ルール1（隣接禁止）は勤務時間が重なっているかどうかに関係なく常に適用する。
  //     急な残業などで勤務時間が伸び、結果的に隣接してしまうケースを避けるため。
  function canPlace(person, seat, state, forbiddenSeatSet, forbiddenPairSet, allowSeat9) {
    if (!allowSeat9 && AUTO_PLACEMENT_EXCLUDED_SEAT_NUMBERS.has(seat.number)) return false;
    const occupants = slotOccupants(state[seat.key]);
    if (occupants.length >= 2) return false;
    if (occupants.length === 1 && overlaps(person, occupants[0])) return false;
    if (forbiddenSeatSet.has(`${person.name}|${seat.key}`)) return false;
    for (const adjKey of ADJACENCY[seat.key]) {
      for (const occ of slotOccupants(state[adjKey])) {
        if (isForbiddenPair(person.name, occ.name, forbiddenPairSet)) return false;
      }
    }
    return true;
  }

  // 現時点のstateで、この人が置ける座席の数を数える（「最も制約がきつい人」を
  // 判定するためのMRV=Minimum Remaining Valuesの指標として使う。値が小さいほど厳しい）。
  // canPlace/ADJACENCYをそのまま使って判定するため、隣接の定義（isAdjacentSeat）が
  // 将来変わっても（例:同列以外の全方向を禁止対象にする等）、この関数は無修正で追従する。
  function countValidSeats(person, state, forbiddenSeatSet, forbiddenPairSet) {
    let n = 0;
    for (const seat of SEATS) {
      if (canPlace(person, seat, state, forbiddenSeatSet, forbiddenPairSet)) n++;
    }
    return n;
  }

  // ============================================================
  // 事前の矛盾検知（ver4.7で追加）
  // 実際に配置を試みて失敗するのを待つのではなく、secret.csvの記載内容だけから
  // 「他の誰の配置状況にも関係なく、どう頑張っても配置不可能」と静的に判定できる
  // ケースを先に洗い出し、原因をピンポイントで示す。
  // ここでの判定は静的な範囲に限定する（他の人の配置状況に依存する動的な矛盾は、
  // 優先度4（隣接禁止・禁止席の配置）の直前に別途チェックする。後述）。
  // ============================================================
  function detectStaticContradictions(byName, forbiddenSeatsMap, forbiddenSeatSet, designatedSeatsMap, supportSeatsMap) {
    const problems = [];

    // A. 禁止席が全15席をカバーしている人（絶対にどこにも座れない）
    for (const [name, seatKeys] of forbiddenSeatsMap.entries()) {
      if (!byName.has(name)) continue;
      const uniqueSeats = new Set(seatKeys);
      if (uniqueSeats.size >= SEATS.length) {
        problems.push(`${name}さんは全${SEATS.length}席が禁止席に指定されており、配置できません。`);
      }
    }

    // B. 固定席／要サポートの指定候補が、本人の禁止席と完全に重複している人
    //   （同じ人のsecret.csv内で指定同士が矛盾しているケース）
    function checkOwnOverlap(map, label) {
      for (const [name, seatKeys] of map.entries()) {
        if (!byName.has(name) || seatKeys.length === 0) continue;
        const remaining = seatKeys.filter(k => !forbiddenSeatSet.has(`${name}|${k}`));
        if (remaining.length === 0) {
          problems.push(`${name}さんの${label}指定（${seatKeys.join('・')}）は、すべて本人の禁止席と重複しており、配置できません。`);
        }
      }
    }
    checkOwnOverlap(designatedSeatsMap, '固定席');
    checkOwnOverlap(supportSeatsMap, '要サポート');

    // C. 同じ1つの座席だけを候補にしている人が3人以上いる（座席の枠は2つまでのため、
    //    候補が他にない以上、確実に(人数-2)名は配置できない）
    const soleClaimants = new Map(); // seatKey -> [name, ...]
    function collectSoleClaims(map) {
      for (const [name, seatKeys] of map.entries()) {
        if (!byName.has(name) || seatKeys.length !== 1) continue;
        const key = seatKeys[0];
        if (!soleClaimants.has(key)) soleClaimants.set(key, []);
        soleClaimants.get(key).push(name);
      }
    }
    collectSoleClaims(designatedSeatsMap);
    collectSoleClaims(supportSeatsMap);
    for (const [seatKey, names] of soleClaimants.entries()) {
      const uniqueNames = [...new Set(names)];
      if (uniqueNames.length > 2) {
        const num = numberOfKey(seatKey);
        problems.push(`座席${num}番（${seatKey}）だけを候補にしている方が${uniqueNames.length}名（${uniqueNames.join('・')}）いますが、1座席の枠は2つまでのため、少なくとも${uniqueNames.length - 2}名は配置できません。`);
      }
    }

    return problems;
  }

  // 候補座席のリストを、渡された順序どおりに（シャッフルせず）先頭から順に試し、
  // 条件に合う最初の1つを返す。固定席の対象座席は、複数指定した場合その入力順が
  // そのまま優先順位になる仕様のため、ランダム選択のfindSeatAmongCandidatesとは
  // 別に用意している。
  // この関数は secret.csv の固定席・要サポートで明示指定された座席リストにのみ
  // 使うため、座席9番の除外チェックは行わない（候補に9番があるのは明示指定が
  // あった場合のみのため）。
  function findSeatInGivenOrder(candidateSeats, person, state, forbiddenSeatSet, forbiddenPairSet) {
    for (const seat of candidateSeats) {
      if (canPlace(person, seat, state, forbiddenSeatSet, forbiddenPairSet, true)) return seat;
    }
    return null;
  }

  // 候補座席のリストの中から、条件に合う最初の1つを返す。
  // avoidAdjacency=true（夜勤専用）の場合、同列で隣接する座席に既に誰かいる候補は
  // 他に選べる候補がある限り避ける（ソフトな優先度。境界時刻一致の回避と同様の扱い）。
  // secret.csvの固定席などにより結果的に隣接してしまうのは許容する（エラーにしない）。
  // deterministic=true（ver4.8で追加。■2 全探索の「その他」決定的配置、および
  // 「次の案」切り替え時の表示安定化に使用）の場合はshuffleせず、渡された順序
  // （＝座席番号順）のまま先頭から探す。省略時はfalse（従来どおりランダム）。
  function findSeatAmongCandidates(candidateSeats, person, state, forbiddenSeatSet, forbiddenPairSet, avoidAdjacency, deterministic) {
    const candidates = deterministic ? candidateSeats.slice() : shuffle(candidateSeats);
    let valid = candidates.filter(seat => canPlace(person, seat, state, forbiddenSeatSet, forbiddenPairSet));
    if (valid.length === 0) return null;
    if (avoidAdjacency) {
      const nonAdjacent = valid.filter(seat => !ADJACENCY[seat.key].some(adjKey => slotOccupants(state[adjKey]).length > 0));
      if (nonAdjacent.length > 0) valid = nonAdjacent;
    }
    const preferred = valid.filter(seat => !hasExactBoundaryMatch(person, slotOccupants(state[seat.key])));
    return (preferred.length > 0 ? preferred : valid)[0];
  }

  // 全15席の中から探す通常版（その他スタッフ・隣接禁止・禁止席対象者・フォールバック用）。
  // deterministic=trueのときは座席番号順（SEATS_IN_NUMBER_ORDER）から探す。
  function findSeat(person, state, forbiddenSeatSet, forbiddenPairSet, avoidAdjacency, deterministic) {
    const pool = deterministic ? SEATS_IN_NUMBER_ORDER : SEATS;
    return findSeatAmongCandidates(pool, person, state, forbiddenSeatSet, forbiddenPairSet, avoidAdjacency, deterministic);
  }

  function seatPerson(state, seatKey, person) {
    const slots = state[seatKey];
    const idx = slots.findIndex(s => s === null);
    slots[idx] = person;
  }

  // 出勤時刻が早い順。同時刻ならshift.csvで後ろの行の人を先に処理する
  // （隣接禁止・禁止席対象者・その他スタッフの両方で使う共通の並び順）
  function byStartTimeThenLaterRowFirst(a, b) {
    if (a.startMin !== b.startMin) return a.startMin - b.startMin;
    return b.shiftIndex - a.shiftIndex;
  }

  // 空席を探して座らせる。見つからなければログを残して「あふれ」に入れる。
  // isExpectedOverflow=true: 通常のあふれ（情報ログのみ）
  // isExpectedOverflow=false: 本来起きないはずの配置ルール矛盾（エラー+ダイアログ）
  function placeOrOverflow(person, state, forbiddenSeatSet, forbiddenPairSet, overflow, placedNames, logs, isExpectedOverflow, avoidAdjacency, deterministic) {
    const seat = findSeat(person, state, forbiddenSeatSet, forbiddenPairSet, avoidAdjacency, deterministic);
    if (seat) {
      seatPerson(state, seat.key, person);
    } else if (isExpectedOverflow) {
      overflow.push(person);
    } else {
      logs.push({
        level: 'error', showDialog: true,
        message: `${person.name}さんを配置できません。配置ルールに矛盾がある可能性があります。secret.csvの条件を確認してください。`,
      });
      overflow.push(person);
    }
    placedNames.add(person.name);
  }

  /**
   * shiftRows:  [{ name, start, end, startMin, endMin }]  (shift.csv記載順)
   * rookieRows: [{ name, degree }]
   * secretRows: [{ type:'adjacent_forbidden', name1, name2 }
   *              | { type:'seat_forbidden', name, row, col }
   *              | { type:'seat_designated', name, row, col }
   *              | { type:'night_gl_designated', name }]
   * options: { nightContext: boolean }（夜勤の座席配置を呼ぶ場合はtrue）
   *   nightContext=true のとき、以下の2つが有効になる:
   *     - 空席探索時に、同列で隣接する座席を（他に選べる候補がある限り）避ける
   *       ソフトな優先度が働く（固定席などで結果的に隣接するのは許容し、
   *       メッセージも出さない）
   *     - secret.csvで「夜勤GL席」に固定席されている人が、選ばれず座席1〜15に
   *       配置された場合、「夜勤GL席」バッジを表示するためのフラグが付く
   *
   * 戻り値: { state, overflow, logs }
   *   state: { "行-列": [人 | null, 人 | null] }
   *   overflow: 配置しきれなかった人の配列
   *   logs: [{ level:'info'|'warn'|'error', message, showDialog? }]
   */
  /**
   * assignSeats（貪欲+MRV）と assignSeatsExhaustive（全探索backtrack。ver4.7で追加）の
   * 両方から呼び出される共通の下ごしらえ処理。
   * 優先フラグ→新人固定席→固定席→教官・OJT→要サポート、までを確定させ、
   * 残った「隣接禁止・禁止席の対象者（remainingPriority）」をどう配置するかは
   * 呼び出し側（貪欲MRV or 全探索backtrack）に委ねる。
   * ロジックを二重管理しないよう、assignSeatsの元の実装をそのままここへ移設したもので、
   * 挙動の変更は一切ない。
   */
  function buildBaseAssignment(shiftRows, rookieRows, secretRows, options) {
    const nightContext = !!(options && options.nightContext);
    const ojtIndexes = buildOjtIndexes(options && options.ojtRows);
    const logs = [];
    const {
      forbiddenPairSet, forbiddenSeatSet, forbiddenSeatsMap, designatedSeatsMap,
      supportSeatsMap, supportNames,
      adjacentRuleNames, forbiddenSeatRuleNames, designatedNames, priorityNames,
      nightGLDesignatedNames, priorityFlagMap,
    } = buildSecretIndexes(secretRows);
    const adjacentGroupLetters = buildAdjacentGroups(secretRows);

    const people = shiftRows.map((r, idx) => ({
      name: r.name, start: r.start, end: r.end,
      startMin: r.startMin, endMin: r.endMin, shiftIndex: idx,
      frontOT: !!r.frontOT, backOT: !!r.backOT,
      // 役割（役席/GL/OP）。座席グリッドに来るのは基本OPだが、夜勤では役席・GLの
      // 2人目以降も座席に配置されるため、役割を保持しておく（夜勤GL枠が空になって
      // いないかの違反チェックで「座席側に夜勤の役席・GLがいるか」の判定に使う）
      role: r.role || 'OP',
      isRookie: false, rookieRank: null,
      hasAdjacentRule: adjacentRuleNames.has(r.name),
      hasForbiddenSeatRule: forbiddenSeatRuleNames.has(r.name),
      isDesignated: designatedNames.has(r.name),
      // バッジ表示用（座席番号・グループ記号）
      designatedSeatNumbers: (designatedSeatsMap.get(r.name) || []).map(numberOfKey),
      forbiddenSeatNumbers: (forbiddenSeatsMap.get(r.name) || []).map(numberOfKey),
      adjacentGroupLetter: adjacentGroupLetters.get(r.name) || null,
      // 夜勤専用: 「夜勤GL席」に固定席されているが座席側に回ってきた人（バッジ表示用）
      hasNightGLDesignation: nightContext && nightGLDesignatedNames.has(r.name),
      // 教官・OJT（ojt.csv）バッジ表示用
      isOjtMentor: ojtIndexes.isMentor.has(r.name),
      isOjtTrainee: ojtIndexes.isTrainee.has(r.name),
      ojtMentorName: ojtIndexes.mentorOf.get(r.name) || null,
      ojtTraineeNames: ojtIndexes.traineesOf.get(r.name) || [],
      // 要サポート（secret.csv「要サポート」種別）バッジ表示用
      isSupport: supportNames.has(r.name),
      supportSeatNumbers: (supportSeatsMap.get(r.name) || []).map(numberOfKey),
      // 優先フラグ（secret.csv5列目）。バッジ表示はしないが、デバッグ・参照用に保持
      priorityFlag: priorityFlagMap.has(r.name) ? priorityFlagMap.get(r.name) : null,
    }));
    const byName = new Map(people.map(p => [p.name, p]));

    // ---- 事前の矛盾検知（静的にわかる範囲）。配置を試みる前にまとめて報告する ----
    const staticProblems = detectStaticContradictions(
      byName, forbiddenSeatsMap, forbiddenSeatSet, designatedSeatsMap, supportSeatsMap
    );
    staticProblems.forEach(message => logs.push({ level: 'error', showDialog: true, message }));

    const state = {};
    for (const s of SEATS) state[s.key] = [null, null];
    const overflow = [];
    const placedNames = new Set();

    // 優先フラグが同数値のときの並び替えに使う「配置ルール順」
    // （新人 > 固定席 > 教官・OJT > 要サポート > その他）
    const rookieNameSet = new Set(rookieRows.map(r => r.name));
    function ruleRank(name) {
      if (rookieNameSet.has(name)) return 0;
      if (designatedSeatsMap.has(name)) return 1;
      if (ojtIndexes.isMentor.has(name) || ojtIndexes.isTrainee.has(name)) return 2;
      if (supportNames.has(name)) return 3;
      return 4;
    }

    // ---- -1. 優先フラグ（secret.csv5列目。全ルールの中で最優先。数値が小さいほど
    //      優先。同数値の場合は「配置ルール順」→出勤時刻順で並べる） ----
    // 対象者が固定席・要サポートの指定を持っていればその候補座席（入力順）を使い、
    // 何も持っていなければ通常の空席探索で配置する。
    const priorityFlagPeople = people.filter(p => priorityFlagMap.has(p.name));
    priorityFlagPeople.sort((a, b) => {
      const fa = priorityFlagMap.get(a.name), fb = priorityFlagMap.get(b.name);
      if (fa !== fb) return fa - fb;
      const rankA = ruleRank(a.name), rankB = ruleRank(b.name);
      if (rankA !== rankB) return rankA - rankB;
      return byStartTimeThenLaterRowFirst(a, b);
    });
    for (const person of priorityFlagPeople) {
      const candidateSeats = [
        ...(designatedSeatsMap.get(person.name) || []),
        ...(supportSeatsMap.get(person.name) || []),
      ].map(key => SEATS.find(s => s.key === key)).filter(Boolean);
      const seat = candidateSeats.length > 0
        ? findSeatInGivenOrder(candidateSeats, person, state, forbiddenSeatSet, forbiddenPairSet)
        : null;
      if (seat) {
        seatPerson(state, seat.key, person);
        placedNames.add(person.name);
        const ruleLabel = (designatedSeatsMap.get(person.name) || []).includes(seat.key) ? '固定席' : '要サポート';
        noteSeat9IfUsed(seat, person.name, ruleLabel, logs);
      } else {
        // 固定席・要サポートの指定がない（または指定席がすべて埋まっていた）場合は
        // 通常の空席探索にフォールバックする
        placeOrOverflow(person, state, forbiddenSeatSet, forbiddenPairSet, overflow, placedNames, logs, false, nightContext);
      }
    }

    // ---- 0. 新人（固定席・2列目） ----
    const matchedRookieRows = rookieRows.filter(n => byName.has(n.name) && !placedNames.has(n.name));
    matchedRookieRows.forEach(n => { byName.get(n.name).isRookie = true; });

    const rookieCandidates = matchedRookieRows.map(n => ({ ...byName.get(n.name), degree: n.degree }));
    rookieCandidates.sort((a, b) => {
      if (a.degree !== b.degree) return a.degree - b.degree; // 数値が小さいほど新人=優先
      return b.shiftIndex - a.shiftIndex; // 同数値: shift.csvで後ろの行がより新人
    });
    const rookieTop = rookieCandidates.slice(0, 4);
    rookieTop.forEach((person, i) => { person.rookieRank = i + 1; });
    const fallbackQueue = [];

    rookieTop.forEach((person, i) => {
      const targetSeat = SEATS.find(s => s.row === i + 1 && s.col === 2);
      // 現状のtargetSeatは常に列2（座席5〜8）のため座席9番になることはないが、
      // 将来この計算式が変わり座席9番が対象になった場合でも新人固定席として
      // 明示的に指定された座席として扱われるよう、allowSeat9=trueを渡しておく。
      if (canPlace(person, targetSeat, state, forbiddenSeatSet, forbiddenPairSet, true)) {
        seatPerson(state, targetSeat.key, person);
        placedNames.add(person.name);
        noteSeat9IfUsed(targetSeat, person.name, '新人固定席', logs);
      } else {
        logs.push({
          level: 'warn', showDialog: true,
          message: `${person.name}さんの配置条件をよく確認してください（新人固定席 ${numberOfSeat(i + 1, 2)}番 に配置できません）`,
        });
        fallbackQueue.push(person);
      }
    });

    // 固定席に座れなかった新人は、通常探索で優先的に配置する（本来は起きない想定のため矛盾扱い）
    for (const person of fallbackQueue) {
      placeOrOverflow(person, state, forbiddenSeatSet, forbiddenPairSet, overflow, placedNames, logs, false, nightContext);
    }

    // ---- 1. 固定席（複数指定されている場合はsecret.csvに入力した順が優先順位になる） ----
    // 候補座席が少ない人ほど融通が利かないため先に配置する（同数の場合は出勤時刻が早い順）。
    // 例えば候補1つの人と候補3つの人が同じ座席を希望している場合、候補3つの人を
    // 先に配置してしまうと、候補1つの人が行き場を失ってしまう可能性があるため。
    // 優先フラグ・新人など、より優先順位の高いステップで既に配置済みの人は除く。
    const designatedPeople = people.filter(p => designatedSeatsMap.has(p.name) && !placedNames.has(p.name));
    designatedPeople.sort((a, b) => {
      const countA = designatedSeatsMap.get(a.name).length;
      const countB = designatedSeatsMap.get(b.name).length;
      if (countA !== countB) return countA - countB;
      return byStartTimeThenLaterRowFirst(a, b);
    });

    for (const person of designatedPeople) {
      const candidateSeats = designatedSeatsMap.get(person.name)
        .map(key => SEATS.find(s => s.key === key))
        .filter(Boolean);
      // 複数の候補座席が指定されている場合、secret.csvに入力した順が
      // そのまま優先順位になる（シャッフルしない）
      const seat = findSeatInGivenOrder(candidateSeats, person, state, forbiddenSeatSet, forbiddenPairSet);
      if (seat) {
        seatPerson(state, seat.key, person);
        placedNames.add(person.name);
        noteSeat9IfUsed(seat, person.name, '固定席', logs);
      } else {
        logs.push({
          level: 'warn', showDialog: true,
          message: `${person.name}さんの配置条件をよく確認してください（指定された座席に配置できません）`,
        });
        // 指定席がどれもダメな場合は、通常探索にフォールバックする
        placeOrOverflow(person, state, forbiddenSeatSet, forbiddenPairSet, overflow, placedNames, logs, false, nightContext);
      }
    }

    // ---- 2. 教官・OJT（ojt.csv） ----
    assignMentorOjt(byName, ojtIndexes, state, forbiddenSeatSet, forbiddenPairSet, overflow, placedNames, logs);

    // ---- 3. 要サポート（固定席と同じ入力・並び順のルール。専用の座席指定がある点も同じ） ----
    // 優先フラグ・新人・固定席・教官OJTで既に配置済みの人は除く。
    const supportPeople = people.filter(p => supportSeatsMap.has(p.name) && !placedNames.has(p.name));
    supportPeople.sort((a, b) => {
      const countA = supportSeatsMap.get(a.name).length;
      const countB = supportSeatsMap.get(b.name).length;
      if (countA !== countB) return countA - countB;
      return byStartTimeThenLaterRowFirst(a, b);
    });

    for (const person of supportPeople) {
      const candidateSeats = supportSeatsMap.get(person.name)
        .map(key => SEATS.find(s => s.key === key))
        .filter(Boolean);
      const seat = findSeatInGivenOrder(candidateSeats, person, state, forbiddenSeatSet, forbiddenPairSet);
      if (seat) {
        seatPerson(state, seat.key, person);
        placedNames.add(person.name);
        noteSeat9IfUsed(seat, person.name, '要サポート', logs);
      } else {
        logs.push({
          level: 'warn', showDialog: true,
          message: `${person.name}さんの配置条件をよく確認してください（要サポートで指定された座席に配置できません）`,
        });
        placeOrOverflow(person, state, forbiddenSeatSet, forbiddenPairSet, overflow, placedNames, logs, false, nightContext);
      }
    }

    // 残った「隣接禁止・禁止席の対象者」。これをどう配置するかは呼び出し側に委ねる
    // （assignSeatsなら貪欲+MRV、assignSeatsExhaustiveなら全探索backtrack）。
    const remainingPriority = people.filter(p => priorityNames.has(p.name) && !placedNames.has(p.name));

    return {
      state, overflow, logs, placedNames, people, byName,
      forbiddenSeatSet, forbiddenPairSet, priorityNames,
      remainingPriority, nightContext,
    };
  }

  // ---- 5. その他スタッフ（出勤時刻が早い順）。assignSeats / assignSeatsExhaustive共通 ----
  // deterministic=true（ver4.8で追加）のときは座席探索をランダムにせず座席番号順で行う。
  // ■2（全探索backtrack）で、隣接禁止・禁止席対象者側の「次の案」を切り替えても
  // その他スタッフが無関係に動き回らないようにするための決定的モード。
  // 省略時はfalse（従来どおりランダム＝通常のassignSeatsの挙動）。
  function placeOthers(people, placedNames, state, forbiddenSeatSet, forbiddenPairSet, overflow, logs, nightContext, deterministic) {
    const others = people.filter(p => !placedNames.has(p.name));
    others.sort(byStartTimeThenLaterRowFirst);
    for (const person of others) {
      placeOrOverflow(person, state, forbiddenSeatSet, forbiddenPairSet, overflow, placedNames, logs, true, nightContext, deterministic);
    }
  }

  /**
   * 貪欲法（+MRVによる並び替え）による通常の座席割り当て。詳細はbuildBaseAssignmentと
   * 下記の各ステップのコメントを参照。
   * 戻り値: { state, overflow, logs }
   *   state: { "行-列": [人 | null, 人 | null] }
   *   overflow: 配置しきれなかった人の配列
   *   logs: [{ level:'info'|'warn'|'error', message, showDialog? }]
   */
  function assignSeats(shiftRows, rookieRows, secretRows, options) {
    const base = buildBaseAssignment(shiftRows, rookieRows, secretRows, options);
    const { state, overflow, logs, placedNames, people, forbiddenSeatSet, forbiddenPairSet, nightContext } = base;
    let remainingPriority = base.remainingPriority;

    // ---- 4. secret.csv 記載スタッフ（隣接禁止・禁止席の対象者） ----
    // 「最も制約がきつい人（＝今この時点で座れる座席が最も少ない人）」から順に配置する
    // （MRV = Minimum Remaining Values の考え方）。1人置くたびに他の人の"座れる座席数"は
    // 変わり得るため、最初に1回だけソートするのではなく、置くたびに数え直す。
    // 座れる座席数が同じ場合は、従来どおり出勤時刻が早い順を使う。

    // ---- 事前の矛盾検知（動的な範囲）----
    // 新人・固定席・教官OJT・要サポートまでの配置が確定した状態(state)で、
    // この時点で既に座れる座席がゼロの人がいないかを、実際に配置を試みる前に洗い出す
    // （禁止席・隣接禁止の条件と、既に確定している他の方の座席の組み合わせによる手詰まり）。
    for (const person of remainingPriority) {
      if (countValidSeats(person, state, forbiddenSeatSet, forbiddenPairSet) === 0) {
        logs.push({
          level: 'error', showDialog: true,
          message: `${person.name}さんは、この時点で座れる座席がありません（禁止席・隣接禁止の条件と、既に確定している他の方の座席の組み合わせにより配置不可能です）。secret.csvの条件を確認してください。`,
        });
      }
    }

    while (remainingPriority.length > 0) {
      let best = null;
      let bestCount = Infinity;
      for (const person of remainingPriority) {
        const cnt = countValidSeats(person, state, forbiddenSeatSet, forbiddenPairSet);
        if (best === null || cnt < bestCount
          || (cnt === bestCount && byStartTimeThenLaterRowFirst(person, best) < 0)) {
          best = person;
          bestCount = cnt;
        }
      }
      remainingPriority = remainingPriority.filter(p => p !== best);
      placeOrOverflow(best, state, forbiddenSeatSet, forbiddenPairSet, overflow, placedNames, logs, false, nightContext);
    }

    // ---- 5. その他スタッフ ----
    placeOthers(people, placedNames, state, forbiddenSeatSet, forbiddenPairSet, overflow, logs, nightContext);

    return { state, overflow, logs };
  }

  // ============================================================
  // ■2（全パターン検索・全探索backtrack）
  // 隣接禁止・禁止席対象者の配置を担当する。普段の貪欲+MRV（assignSeats）
  // とはロジックの性格が異なる（実際にすべての組み合わせを尽くす）ため、可読性のために
  // ここでセクションを分けている（旧ver4.8まではalgorithmExhaustive.jsという別ファイルに
  // 分離していたが、ver4.9でこのファイルへ統合した。読み込むファイルが1つで済むほか、
  // window.SeatTool.algorithm 内で完結するため<script>タグの順序を気にする必要もない）。
  // 「自動配置を実行」のたびに日勤・夜勤それぞれでこれを試し、解けた場合はそれを採用、
  // 解けない場合（証明つきで解なし、またはタイムアウト）にのみ貪欲+MRV（assignSeats）に
  // フォールバックする（呼び出し側のui.jsで制御）。
  // ============================================================

  function deepCloneState(state) {
    const copy = {};
    for (const key of Object.keys(state)) copy[key] = state[key].slice();
    return copy;
  }

  // 探索の分岐が違っても最終的に同じ割り当て（name -> seatKey の組み合わせ）に
  // たどり着くことがある（無関係な2人の処理順が入れ替わっただけ、など）ため、
  // 「次の案」ボタンで同じ内容の案が重複して出てこないよう、正規化した文字列で
  // 重複排除する。
  function canonicalAssignmentKey(assignedMap) {
    return Array.from(assignedMap.entries())
      .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
      .map(([name, seatKey]) => `${name}=${seatKey}`)
      .join(',');
  }

  // 完成した座席表(state)の「良さ」を採点する。値が小さいほど良い。
  // ・boundaryMatches: 境界時刻ぴったりの同席（同じ座席で、片方の終業とすぐもう片方の
  //   始業が接している組み合わせ）の件数。少ないほど気まずさが少なく望ましい。
  // ・variance: 各座席の埋まり方（0/1/2人）の分散。小さいほど席の偏りが少ない。
  // 現状これ以外の優劣指標は無いため、この2つの組み合わせで暫定的に順位付けする
  // （必要に応じて指標を追加・調整できるよう、内訳をそのまま返す）。
  function scoreSolution(state) {
    let boundaryMatches = 0;
    const counts = [];
    for (const seat of SEATS) {
      const occ = slotOccupants(state[seat.key]);
      counts.push(occ.length);
      if (occ.length === 2 && (occ[0].endMin === occ[1].startMin || occ[1].endMin === occ[0].startMin)) {
        boundaryMatches++;
      }
    }
    const mean = counts.reduce((a, b) => a + b, 0) / counts.length;
    const variance = counts.reduce((a, b) => a + (b - mean) * (b - mean), 0) / counts.length;
    return { boundaryMatches, variance };
  }

  /**
   * ■2: 隣接禁止・禁止席対象者について、真の全探索（枝刈り付きbacktrack）を行う。
   * assignSeats（貪欲+MRV+乱数リトライ）では「たまたま見つからなかっただけ」の
   * 可能性が残るのに対し、こちらは実際にすべての座席割り当てを尽くすため、
   * 「本当に解が存在するか」を（タイムアウトしない限り）証明つきで判定できる。
   *
   * 新人・固定席・教官OJT・要サポートまでは buildBaseAssignment で通常どおり確定させ
   * （この部分はassignSeatsと完全に同じロジック。ここを揺らがせると探索対象が
   * 際限なく広がってしまうため、意図的に固定値として扱う）、
   * その後に残った隣接禁止・禁止席対象者だけをbacktrack探索の対象にする。
   *
   * options:
   *   maxSolutions: 最終的に返す上位解の件数（既定20。「次の案」ボタンで一巡できる件数の目安）
   *   poolCap:      採点前に内部的に集める解の件数の上限（既定60。多すぎると採点コストが増えるため上限を設ける）
   *   timeBudgetMs: 探索の制限時間（既定2000ms=2秒。「自動配置を実行」のたびに日勤・夜勤
   *                 それぞれで走らせる前提のため短めに設定。隣接禁止・禁止席対象者は通常
   *                 少人数のはずで、実運用では一瞬で解が出る想定）。これを超えたら打ち切り、
   *                 その時点で見つかっている解・部分解で結果を返す（timedOut:trueで示す）
   *
   * 戻り値: {
   *   feasible: boolean,        対象者全員を配置できる解が1つ以上見つかったか
   *   timedOut: boolean,        制限時間で打ち切ったか（true の場合、feasible:false でも
   *                             「本当に解なし」と証明できたわけではない点に注意）
   *   nodesExplored: number,    探索した分岐の数（目安）
   *   elapsedMs: number,        全探索にかかった実時間（ミリ秒）
   *   totalSolutionsFound: number,  poolCap内で実際に見つかった（重複排除後の）解の総数
   *   solutions: [{
   *     state, overflow, logs, score,               完成した座席表（「その他」を含む）
   *     stateBeforeOthers, overflowBeforeOthers,     「その他」を配置する直前の状態
   *     logsBeforeOthers, placedNamesBeforeOthers,   （reshuffleOthers用に保持）
   *   }],  スコア順（良い順）の上位solutions。「その他」はランダムではなく
   *        座席番号順の決定的な順序で配置している（隣接禁止・禁止席対象者側の案を
   *        切り替えたときに、その他の人が無関係に動いて見えるのを防ぐため）。
   *   bestPartial: null | { placedCount, unplacedNames },
   *     feasible:false のとき、最も惜しかった（最も多く配置できた）部分解の情報。
   *     unplacedNamesがその組み合わせで配置できなかった人（探索全体で他の組み合わせなら
   *     配置できた可能性はあるため、あくまで参考情報）
   *   context: { people, forbiddenSeatSet, forbiddenPairSet, nightContext },
   *     reshuffleOthers(solution, context) を呼ぶ際にそのまま渡すための共通情報。
   * }
   */
  function assignSeatsExhaustive(shiftRows, rookieRows, secretRows, options) {
    const opts = options || {};
    const maxSolutions = opts.maxSolutions || 20;
    const poolCap = opts.poolCap || 60;
    const timeBudgetMs = opts.timeBudgetMs || 2000;

    const base = buildBaseAssignment(shiftRows, rookieRows, secretRows, options);
    const {
      state: baseState, placedNames: basePlacedNames, people, byName,
      forbiddenSeatSet, forbiddenPairSet, remainingPriority, nightContext,
      overflow: baseOverflow, logs: baseLogs,
    } = base;

    const searchState = deepCloneState(baseState);
    // 探索順を実行のたびに変えることで、再実行時に別の解の集合を見つけやすくする
    // （backtrack自体の正しさには影響しない。あくまで探索の"当たりやすさ"の多様化）
    const seatsForSearch = shuffle(SEATS);

    const startTime = Date.now();
    let timedOut = false;
    let nodesExplored = 0;
    const foundAssignments = []; // Map(name -> seatKey) の配列（重複排除済み）
    const seenKeys = new Set(); // canonicalAssignmentKey済みの組み合わせ（重複排除用）
    let bestPartial = null;

    function search(remaining, assignedMap) {
      if (timedOut) return;
      if (Date.now() - startTime > timeBudgetMs) { timedOut = true; return; }
      nodesExplored++;

      if (remaining.length === 0) {
        // 探索の分岐が違っても同じ組み合わせに行き着くことがあるため、
        // 正規化キーで重複を排除してから記録する
        const key = canonicalAssignmentKey(assignedMap);
        if (!seenKeys.has(key)) {
          seenKeys.add(key);
          foundAssignments.push(new Map(assignedMap));
        }
        return;
      }

      // 簡易な人数上限チェック（時間の重なりは考慮しない粗い上限だが、計算はほぼ無料な
      // ので、明らかに席数が足りていない枝はMRVの詳細計算に入る前に早期に切り捨てる）
      let totalEmptySlots = 0;
      for (const seat of seatsForSearch) totalEmptySlots += 2 - slotOccupants(searchState[seat.key]).length;
      if (remaining.length > totalEmptySlots) {
        if (!bestPartial || assignedMap.size > bestPartial.placedCount) {
          bestPartial = { placedCount: assignedMap.size, unplacedNames: remaining.map(p => p.name) };
        }
        return;
      }

      // MRV: 残っている中で最も候補座席が少ない人を次に処理する（枝刈りの効率化のため）
      let bestIdx = -1;
      let bestCount = Infinity;
      let bestCandidates = null;
      for (let i = 0; i < remaining.length; i++) {
        const cands = seatsForSearch.filter(seat =>
          canPlace(remaining[i], seat, searchState, forbiddenSeatSet, forbiddenPairSet));
        if (cands.length < bestCount) {
          bestCount = cands.length;
          bestIdx = i;
          bestCandidates = cands;
          if (bestCount === 0) break;
        }
      }

      if (bestCount === 0) {
        // この枝はこれ以上進めない（手詰まり）。参考情報として、ここまでに
        // 配置できていた人数が過去最高なら記録しておく。
        if (!bestPartial || assignedMap.size > bestPartial.placedCount) {
          bestPartial = {
            placedCount: assignedMap.size,
            unplacedNames: remaining.map(p => p.name),
          };
        }
        return;
      }

      const person = remaining[bestIdx];
      const rest = remaining.slice(0, bestIdx).concat(remaining.slice(bestIdx + 1));

      for (const seat of bestCandidates) {
        seatPerson(searchState, seat.key, person);
        assignedMap.set(person.name, seat.key);

        search(rest, assignedMap);

        assignedMap.delete(person.name);
        const slots = searchState[seat.key];
        const idx = slots.indexOf(person);
        if (idx !== -1) slots[idx] = null;

        if (timedOut || foundAssignments.length >= poolCap) return;
      }
    }

    search(remainingPriority, new Map());

    const feasible = foundAssignments.length > 0;

    function buildFullResult(assignedMap) {
      // 隣接禁止・禁止席対象者（remainingPriority）まで確定させた状態を、
      // 「その他」を配置する直前のスナップショットとして保持しておく。
      // これにより、あとから reshuffleOthers() で隣接禁止・禁止席対象者側の配置は
      // そのままに「その他」だけを配置し直せる（■2の「その他だけシャッフル」ボタン用）。
      const stateBeforeOthers = deepCloneState(baseState);
      for (const [name, seatKey] of assignedMap.entries()) {
        seatPerson(stateBeforeOthers, seatKey, byName.get(name));
      }
      const placedNamesBeforeOthers = new Set(basePlacedNames);
      for (const name of assignedMap.keys()) placedNamesBeforeOthers.add(name);
      const overflowBeforeOthers = baseOverflow.slice();
      const logsBeforeOthers = baseLogs.slice();

      // 「その他」は既定では座席番号順の決定的な配置にする（ランダムにしない）。
      // ランダムな配置がほしい場合は reshuffleOthers() を別途呼ぶ（■2の
      // 「その他だけシャッフル」ボタン用）。これにより、隣接禁止・禁止席対象者側の
      // 「次の案」を切り替えたときに、その他の人が無関係に動いて見えるのを防ぐ。
      const state = deepCloneState(stateBeforeOthers);
      const overflow = overflowBeforeOthers.slice();
      const logs = logsBeforeOthers.slice();
      const placedNames = new Set(placedNamesBeforeOthers);
      placeOthers(people, placedNames, state, forbiddenSeatSet, forbiddenPairSet, overflow, logs, nightContext, true /* deterministic */);

      return {
        state, overflow, logs, score: scoreSolution(state),
        stateBeforeOthers, overflowBeforeOthers, logsBeforeOthers, placedNamesBeforeOthers,
      };
    }

    const fullResults = foundAssignments.map(buildFullResult);
    fullResults.sort((a, b) => {
      if (a.score.boundaryMatches !== b.score.boundaryMatches) return a.score.boundaryMatches - b.score.boundaryMatches;
      return a.score.variance - b.score.variance;
    });

    return {
      feasible,
      timedOut,
      nodesExplored,
      elapsedMs: Date.now() - startTime,
      totalSolutionsFound: foundAssignments.length,
      solutions: fullResults.slice(0, maxSolutions),
      bestPartial: feasible ? null : bestPartial,
      // reshuffleOthers(solution, context) を呼ぶ際にそのまま渡す共通情報
      context: { people, forbiddenSeatSet, forbiddenPairSet, nightContext },
    };
  }

  /**
   * 隣接禁止・禁止席対象者側の座席はそのままに、
   * 「その他」スタッフだけをランダムに配置し直す（■2の「その他だけシャッフル」ボタン用）。
   * solution: assignSeatsExhaustive の戻り値 solutions[i]（stateBeforeOthers等を含むもの）
   * context:  assignSeatsExhaustive の戻り値の context をそのまま渡す
   * 戻り値: { state, overflow, logs, score }（buildFullResultの戻り値と同形。
   *          stateBeforeOthers等は変わらないため呼び出し側で使い回せる）
   */
  function reshuffleOthers(solution, context) {
    const state = deepCloneState(solution.stateBeforeOthers);
    const overflow = solution.overflowBeforeOthers.slice();
    const logs = solution.logsBeforeOthers.slice();
    const placedNames = new Set(solution.placedNamesBeforeOthers);
    placeOthers(
      context.people, placedNames, state,
      context.forbiddenSeatSet, context.forbiddenPairSet,
      overflow, logs, context.nightContext,
      false /* deterministic=false → ランダムに配置し直す */
    );
    return { state, overflow, logs, score: scoreSolution(state) };
  }

  // ============================================================
  // 早番・遅番エリア（役席・GL専用。それぞれ2行×3列=6枠、1枠1名）
  // ・「遅番」判定（isLate）は呼び出し側で付与済みの値をそのまま使う
  //   （開始時刻が12:00以降、または前残業TRUEかつ開始時刻が10:00以降）
  // ・役席→GLの順に、それぞれ出勤時刻が早い順（同時刻ならCSVで後ろの行の人が先）に
  //   1マス目から詰めて配置する
  // ・合計6名を超える分（7人目以降）は「あふれ」に入れる（呼び出し側で
  //   通常のあふれ欄に合流させる。実運用上まず発生しない想定だが、発生しても
  //   カードが消えてしまわないようにするため）
  // ============================================================
  function emptyLeaderState() {
    const s = {};
    for (let r = 1; r <= 2; r++) for (let c = 1; c <= 3; c++) s[`${r}-${c}`] = null;
    return s;
  }

  // overflowOut: 7人目以降を積み込む配列（呼び出し側で用意し、early・lateの
  // 両方から共通で渡す。あふれとして扱うだけなので、あふれの理由を示す個別の
  // メッセージは出さない＝通常の座席1〜15があふれる場合と同じ扱い）
  function fillLeaderArea(stateObj, peopleList, overflowOut) {
    const yakuseki = peopleList.filter(p => p.role === '役席').sort(byStartTimeThenLaterRowFirst);
    const gl = peopleList.filter(p => p.role === 'GL').sort(byStartTimeThenLaterRowFirst);
    const combined = [...yakuseki, ...gl];

    const positions = new Array(6).fill(null);
    combined.forEach((p, i) => {
      if (i < 6) positions[i] = p;
      else overflowOut.push(p);
    });

    let n = 0;
    for (let r = 1; r <= 2; r++) {
      for (let c = 1; c <= 3; c++) {
        stateObj[`${r}-${c}`] = positions[n];
        n++;
      }
    }
  }

  /**
   * leaderRows: [{ name, start, end, startMin, endMin, frontOT, backOT, role:'役席'|'GL', isLate }]
   *   （役割が役席・GLのスタッフのみを渡すこと。日付抽出済みであること）
   * 戻り値: { early, late, logs, overflow }
   *   early / late: { "行-列": 人 | null }（1〜2の2行×3列、1枠1名）
   *   overflow: 6名を超えて配置できなかった人（呼び出し側で通常のあふれ欄に合流させる）
   */
  function assignLeaderAreas(leaderRows) {
    const logs = [];
    const overflow = [];
    const early = emptyLeaderState();
    const late = emptyLeaderState();

    const withIndex = leaderRows.map((r, idx) => ({ ...r, shiftIndex: idx }));
    const earlyPeople = withIndex.filter(p => !p.isLate);
    const latePeople = withIndex.filter(p => p.isLate);

    fillLeaderArea(early, earlyPeople, overflow);
    fillLeaderArea(late, latePeople, overflow);

    return { early, late, logs, overflow };
  }

  // ============================================================
  // 夜勤の役席・GLの配置（ver4.2）
  // ・二重配置（GL枠＋座席の両方に表示）は行わない。日勤と同様に1人1か所へ配置する。
  // ・1名のみの場合: 夜勤GL枠の「2行1列目」へ配置する
  // ・2名以上の場合: 1名を夜勤GL枠2行1列目へ。
  //     - secret.csvで固定席「夜勤GL席」に指定されている人を優先する
  //     - 該当者が複数いる場合はその中からランダムに選出
  //     - 該当者がいない場合は全員の中からランダムに選出
  //   残りのうち先頭の1名（役席→GLの順・出勤時刻が早い順）は座席10へ、
  //   3人目以降は空いている座席への通常配置（時刻順）に回す。
  //   （座席10への強制配置は呼び出し側でsecret.csvへ一時的に追加する形で行う。
  //   secret.csvには実在しない指定のため、呼び出し側でsilent:trueを付けることで
  //   「固定席」バッジは表示させない）
  // ============================================================
  /**
   * nightLeaderRows: [{ name, start, end, startMin, endMin, frontOT, backOT, role:'役席'|'GL' }]
   * nightGLDesignatedNames: secret.csv「固定席・夜勤GL席」の対象者名の集合（Set）。
   *   buildSecretIndexes(secretRows).nightGLDesignatedNames をそのまま渡せばよい
   *   （その日出勤していない人が含まれていても、この関数内で自動的に絞り込まれる）
   * 戻り値: {
   *   glState,       … 夜勤GL枠（2行×3列）。2行1列目にのみ配置される
   *   seatLeaders,   … 座席側に回す役席・GL（役席→GL・時刻順。先頭が座席10行き）
   *   seat10Name,    … 座席10へ強制配置するリーダーの氏名（いなければnull）
   *   logs,
   * }
   */
  function assignNightLeaders(nightLeaderRows, nightGLDesignatedNames) {
    const logs = [];
    const glState = emptyLeaderState();
    const flagSet = nightGLDesignatedNames || new Set();

    const withIndex = nightLeaderRows.map((r, idx) => ({ ...r, shiftIndex: idx }));
    const yakuseki = withIndex.filter(p => p.role === '役席').sort(byStartTimeThenLaterRowFirst);
    const gl = withIndex.filter(p => p.role === 'GL').sort(byStartTimeThenLaterRowFirst);
    const ordered = [...yakuseki, ...gl];

    if (ordered.length === 0) {
      return { glState, seatLeaders: [], seat10Name: null, logs };
    }

    // 夜勤GL枠(2行1列目)に入れる1名を決める
    let glPerson;
    if (ordered.length === 1) {
      glPerson = ordered[0];
    } else {
      const flagged = ordered.filter(p => flagSet.has(p.name));
      const pool = flagged.length > 0 ? flagged : ordered;
      glPerson = pool[Math.floor(Math.random() * pool.length)];
      // 候補が複数いてランダム選出になった場合のみ通知する。
      // 固定席「夜勤GL席」の該当者が1名で、その人がそのまま夜勤GL枠に
      // 入った場合は、指定どおりの結果のためメッセージは出さない（ver4.5）。
      if (pool.length > 1) {
        const poolLabel = flagged.length > 0 ? '固定席（夜勤GL席）のある' : '';
        logs.push({ level: 'info', message: `夜勤GL枠（2行1列目）には、${poolLabel}${pool.length}名の中からランダムで${glPerson.name}さんを配置しました。` });
      }
    }
    glState['2-1'] = glPerson;

    const seatLeaders = ordered.filter(p => p !== glPerson);
    const seat10Name = seatLeaders.length > 0 ? seatLeaders[0].name : null;
    return { glState, seatLeaders, seat10Name, logs };
  }

  return {
    SEATS, seatExists, ADJACENCY, assignSeats,
    buildSecretIndexes, buildAdjacentGroups, canPlace, overlaps, isForbiddenPair,
    seatByNumber, numberOfKey, numberOfSeat,
    assignLeaderAreas, assignNightLeaders,
    buildOjtIndexes,
    countValidSeats, detectStaticContradictions,
    buildBaseAssignment,
    // 以下は内部関数だが、■2（全探索backtrack）やテストから使うために公開している
    seatPerson, slotOccupants, shuffle, placeOthers,
    SEATS_IN_NUMBER_ORDER, findSeat, findSeatAmongCandidates,
    // ■2（全パターン検索・全探索backtrack。ver4.9でこのファイルに統合）
    assignSeatsExhaustive, reshuffleOthers, scoreSolution,
  };
})();
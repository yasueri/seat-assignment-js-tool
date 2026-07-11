// ============================================================
// algorithm.js
// 座席の定義と、新人固定席 → secret.csv対象者 → その他スタッフ
// の順で座席を割り当てるアルゴリズムを担当する。
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
  // 禁止席・席固定は1人につき1行（対象座席はスペース区切りで複数指定）で書く
  // 仕様のため、ここではその1行から生じた複数のseatKeyを配列にまとめるだけでよい。
  function buildSecretIndexes(secretRows) {
    const forbiddenPairSet = new Set();
    const forbiddenSeatSet = new Set();
    const forbiddenSeatsMap = new Map(); // name -> [seatKey, ...]（バッジ表示用）
    const designatedSeatsMap = new Map(); // name -> [seatKey, ...]
    const adjacentRuleNames = new Set();
    const forbiddenSeatRuleNames = new Set();
    const designatedNames = new Set();
    const nightGLDesignatedNames = new Set(); // 席固定「夜勤GL席」の対象者名

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
        // designatedNames には加えないため「席固定」バッジは表示されない
        // （夜勤の役席・GLが2名以上のとき座席10へ回る人の配置に使用）。
        if (!r.silent) designatedNames.add(r.name);
      } else if (r.type === 'night_gl_designated') {
        nightGLDesignatedNames.add(r.name);
      }
    }

    // 優先処理・バッジ表示のために使う「何かしらsecret.csvに載っている人」の集合
    const priorityNames = new Set([...adjacentRuleNames, ...forbiddenSeatRuleNames, ...designatedNames]);

    return {
      forbiddenPairSet, forbiddenSeatSet, forbiddenSeatsMap, designatedSeatsMap,
      adjacentRuleNames, forbiddenSeatRuleNames, designatedNames, priorityNames,
      nightGLDesignatedNames,
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

  // 座席1つに対して、この人を配置してよいか（容量・重複・ルール1・ルール2）
  // 注: ルール1（隣接禁止）は勤務時間が重なっているかどうかに関係なく常に適用する。
  //     急な残業などで勤務時間が伸び、結果的に隣接してしまうケースを避けるため。
  function canPlace(person, seat, state, forbiddenSeatSet, forbiddenPairSet) {
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

  // 候補座席のリストの中から、ランダムな順で条件に合う最初の1つを返す。
  // avoidAdjacency=true（夜勤専用）の場合、同列で隣接する座席に既に誰かいる候補は
  // 他に選べる候補がある限り避ける（ソフトな優先度。境界時刻一致の回避と同様の扱い）。
  // secret.csvの席固定などにより結果的に隣接してしまうのは許容する（エラーにしない）。
  function findSeatAmongCandidates(candidateSeats, person, state, forbiddenSeatSet, forbiddenPairSet, avoidAdjacency) {
    const candidates = shuffle(candidateSeats);
    let valid = candidates.filter(seat => canPlace(person, seat, state, forbiddenSeatSet, forbiddenPairSet));
    if (valid.length === 0) return null;
    if (avoidAdjacency) {
      const nonAdjacent = valid.filter(seat => !ADJACENCY[seat.key].some(adjKey => slotOccupants(state[adjKey]).length > 0));
      if (nonAdjacent.length > 0) valid = nonAdjacent;
    }
    const preferred = valid.filter(seat => !hasExactBoundaryMatch(person, slotOccupants(state[seat.key])));
    return (preferred.length > 0 ? preferred : valid)[0];
  }

  // 全15席の中から探す通常版（その他スタッフ・secret.csv対象者・フォールバック用）
  function findSeat(person, state, forbiddenSeatSet, forbiddenPairSet, avoidAdjacency) {
    return findSeatAmongCandidates(SEATS, person, state, forbiddenSeatSet, forbiddenPairSet, avoidAdjacency);
  }

  function seatPerson(state, seatKey, person) {
    const slots = state[seatKey];
    const idx = slots.findIndex(s => s === null);
    slots[idx] = person;
  }

  // 出勤時刻が早い順。同時刻ならshift.csvで後ろの行の人を先に処理する
  // （secret.csv対象者・その他スタッフの両方で使う共通の並び順）
  function byStartTimeThenLaterRowFirst(a, b) {
    if (a.startMin !== b.startMin) return a.startMin - b.startMin;
    return b.shiftIndex - a.shiftIndex;
  }

  // 空席を探して座らせる。見つからなければログを残して「あふれ」に入れる。
  // isExpectedOverflow=true: 通常のあふれ（情報ログのみ）
  // isExpectedOverflow=false: 本来起きないはずの配置ルール矛盾（エラー+ダイアログ）
  function placeOrOverflow(person, state, forbiddenSeatSet, forbiddenPairSet, overflow, placedNames, logs, isExpectedOverflow, avoidAdjacency) {
    const seat = findSeat(person, state, forbiddenSeatSet, forbiddenPairSet, avoidAdjacency);
    if (seat) {
      seatPerson(state, seat.key, person);
    } else if (isExpectedOverflow) {
      logs.push({ level: 'info', message: `${person.name}さんは座席に配置できず「あふれ」になりました。` });
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
   *       ソフトな優先度が働く（席固定などで結果的に隣接するのは許容し、
   *       メッセージも出さない）
   *     - secret.csvで「夜勤GL席」に席固定されている人が、選ばれず座席1〜15に
   *       配置された場合、「夜勤GL席」バッジを表示するためのフラグが付く
   *
   * 戻り値: { state, overflow, logs }
   *   state: { "行-列": [人 | null, 人 | null] }
   *   overflow: 配置しきれなかった人の配列
   *   logs: [{ level:'info'|'warn'|'error', message, showDialog? }]
   */
  function assignSeats(shiftRows, rookieRows, secretRows, options) {
    const nightContext = !!(options && options.nightContext);
    const logs = [];
    const {
      forbiddenPairSet, forbiddenSeatSet, forbiddenSeatsMap, designatedSeatsMap,
      adjacentRuleNames, forbiddenSeatRuleNames, designatedNames, priorityNames,
      nightGLDesignatedNames,
    } = buildSecretIndexes(secretRows);
    const adjacentGroupLetters = buildAdjacentGroups(secretRows);

    const people = shiftRows.map((r, idx) => ({
      name: r.name, start: r.start, end: r.end,
      startMin: r.startMin, endMin: r.endMin, shiftIndex: idx,
      frontOT: !!r.frontOT, backOT: !!r.backOT,
      isRookie: false, rookieRank: null,
      hasAdjacentRule: adjacentRuleNames.has(r.name),
      hasForbiddenSeatRule: forbiddenSeatRuleNames.has(r.name),
      isDesignated: designatedNames.has(r.name),
      // バッジ表示用（座席番号・グループ記号）
      designatedSeatNumbers: (designatedSeatsMap.get(r.name) || []).map(numberOfKey),
      forbiddenSeatNumbers: (forbiddenSeatsMap.get(r.name) || []).map(numberOfKey),
      adjacentGroupLetter: adjacentGroupLetters.get(r.name) || null,
      // 夜勤専用: 「夜勤GL席」に席固定されているが座席側に回ってきた人（バッジ表示用）
      hasNightGLDesignation: nightContext && nightGLDesignatedNames.has(r.name),
    }));
    const byName = new Map(people.map(p => [p.name, p]));

    const state = {};
    for (const s of SEATS) state[s.key] = [null, null];
    const overflow = [];
    const placedNames = new Set();

    // ---- 0. 席固定（最優先。候補が複数あればどれか1つでよい） ----
    // 候補座席が少ない人ほど融通が利かないため先に配置する（同数の場合は出勤時刻が早い順）。
    // 例えば候補1つの人と候補3つの人が同じ座席を希望している場合、候補3つの人を
    // 先に配置してしまうと、候補1つの人が行き場を失ってしまう可能性があるため。
    const designatedPeople = people.filter(p => designatedSeatsMap.has(p.name));
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
      const seat = findSeatAmongCandidates(candidateSeats, person, state, forbiddenSeatSet, forbiddenPairSet, nightContext);
      if (seat) {
        seatPerson(state, seat.key, person);
        placedNames.add(person.name);
      } else {
        logs.push({
          level: 'warn', showDialog: true,
          message: `${person.name}さんの配置条件をよく確認してください（指定された座席に配置できません）`,
        });
        // 指定席がどれもダメな場合は、通常探索にフォールバックする
        placeOrOverflow(person, state, forbiddenSeatSet, forbiddenPairSet, overflow, placedNames, logs, false, nightContext);
      }
    }

    // ---- 1. 新人（固定席・2列目） ----
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
      if (canPlace(person, targetSeat, state, forbiddenSeatSet, forbiddenPairSet)) {
        seatPerson(state, targetSeat.key, person);
        placedNames.add(person.name);
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

    // ---- 2. secret.csv 記載スタッフ（隣接禁止・禁止席の対象者。出勤時刻が早い順） ----
    const priorityPeople = people.filter(p => priorityNames.has(p.name) && !placedNames.has(p.name));
    priorityPeople.sort(byStartTimeThenLaterRowFirst);

    for (const person of priorityPeople) {
      placeOrOverflow(person, state, forbiddenSeatSet, forbiddenPairSet, overflow, placedNames, logs, false, nightContext);
    }

    // ---- 3. その他スタッフ（出勤時刻が早い順） ----
    const others = people.filter(p => !placedNames.has(p.name));
    others.sort(byStartTimeThenLaterRowFirst);

    for (const person of others) {
      placeOrOverflow(person, state, forbiddenSeatSet, forbiddenPairSet, overflow, placedNames, logs, true, nightContext);
    }

    return { state, overflow, logs };
  }

  // ============================================================
  // 早番・遅番エリア（役席・GL専用。それぞれ2行×3列=6枠、1枠1名）
  // ・「遅番」判定（isLate）は呼び出し側で付与済みの値をそのまま使う
  //   （開始時刻が12:00以降、または前残業TRUEかつ開始時刻が10:00以降）
  // ・役席→GLの順に、それぞれ出勤時刻が早い順（同時刻ならCSVで後ろの行の人が先）に
  //   1マス目から詰めて配置する
  // ・合計6名を超える分（7人目以降）はどこにも配置せず、メッセージで知らせる
  //   （あふれには入れない。実運用上まず発生しない想定のため）
  // ============================================================
  function emptyLeaderState() {
    const s = {};
    for (let r = 1; r <= 2; r++) for (let c = 1; c <= 3; c++) s[`${r}-${c}`] = null;
    return s;
  }

  function fillLeaderArea(stateObj, peopleList, logs, excessMessage) {
    const yakuseki = peopleList.filter(p => p.role === '役席').sort(byStartTimeThenLaterRowFirst);
    const gl = peopleList.filter(p => p.role === 'GL').sort(byStartTimeThenLaterRowFirst);
    const combined = [...yakuseki, ...gl];

    const positions = new Array(6).fill(null);
    combined.forEach((p, i) => { if (i < 6) positions[i] = p; });
    const excessCount = Math.max(0, combined.length - 6);

    let n = 0;
    for (let r = 1; r <= 2; r++) {
      for (let c = 1; c <= 3; c++) {
        stateObj[`${r}-${c}`] = positions[n];
        n++;
      }
    }

    if (excessCount > 0) {
      logs.push({
        level: 'error',
        showDialog: true,
        message: excessMessage,
      });
    }
  }

  const LEADER_EXCESS_MESSAGE = '役席・GLの合計が6名を超えており、配置できません。プリントアウト後に手書きしてください';

  /**
   * leaderRows: [{ name, start, end, startMin, endMin, frontOT, backOT, role:'役席'|'GL', isLate }]
   *   （役割が役席・GLのスタッフのみを渡すこと。日付抽出済みであること）
   * 戻り値: { early, late, logs }
   *   early / late: { "行-列": 人 | null }（1〜2の2行×3列、1枠1名）
   */
  function assignLeaderAreas(leaderRows) {
    const logs = [];
    const early = emptyLeaderState();
    const late = emptyLeaderState();

    const withIndex = leaderRows.map((r, idx) => ({ ...r, shiftIndex: idx }));
    const earlyPeople = withIndex.filter(p => !p.isLate);
    const latePeople = withIndex.filter(p => p.isLate);

    fillLeaderArea(early, earlyPeople, logs, LEADER_EXCESS_MESSAGE);
    fillLeaderArea(late, latePeople, logs, LEADER_EXCESS_MESSAGE);

    return { early, late, logs };
  }

  // ============================================================
  // 夜勤の役席・GLの配置（ver4.2）
  // ・二重配置（GL枠＋座席の両方に表示）は行わない。日勤と同様に1人1か所へ配置する。
  // ・1名のみの場合: 夜勤GL枠の「2行1列目」へ配置する
  // ・2名以上の場合: 1名を夜勤GL枠2行1列目へ。
  //     - secret.csvで席固定「夜勤GL席」に指定されている人を優先する
  //     - 該当者が複数いる場合はその中からランダムに選出
  //     - 該当者がいない場合は全員の中からランダムに選出
  //   残りのうち先頭の1名（役席→GLの順・出勤時刻が早い順）は座席10へ、
  //   3人目以降は空いている座席への通常配置（時刻順）に回す。
  //   （座席10への強制配置は呼び出し側でsecret.csvへ一時的に追加する形で行う。
  //   secret.csvには実在しない指定のため、呼び出し側でsilent:trueを付けることで
  //   「席固定」バッジは表示させない）
  // ============================================================
  /**
   * nightLeaderRows: [{ name, start, end, startMin, endMin, frontOT, backOT, role:'役席'|'GL' }]
   * nightGLDesignatedNames: secret.csv「席固定・夜勤GL席」の対象者名の集合（Set）。
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
      if (pool.length > 1) {
        const poolLabel = flagged.length > 0 ? '席固定（夜勤GL席）のある' : '';
        logs.push({ level: 'info', message: `夜勤GL枠（2行1列目）には、${poolLabel}${pool.length}名の中からランダムで${glPerson.name}さんを配置しました。` });
      } else {
        logs.push({ level: 'info', message: `夜勤GL枠（2行1列目）に、席固定（夜勤GL席）のある${glPerson.name}さんを配置しました。` });
      }
    }
    glState['2-1'] = glPerson;

    const seatLeaders = ordered.filter(p => p !== glPerson);
    const seat10Name = seatLeaders.length > 0 ? seatLeaders[0].name : null;
    if (seat10Name) {
      logs.push({ level: 'info', message: `夜勤の役席・GLが2名以上のため、${seat10Name}さんを座席10へ配置します。` });
    }
    return { glState, seatLeaders, seat10Name, logs };
  }

  return {
    SEATS, seatExists, ADJACENCY, assignSeats,
    buildSecretIndexes, buildAdjacentGroups, canPlace, overlaps, isForbiddenPair,
    seatByNumber, numberOfKey, numberOfSeat,
    assignLeaderAreas, assignNightLeaders,
  };
})();

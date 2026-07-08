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
  // 座席禁止・座席指定は、同じ人に対して複数行あってよい
  // （座席禁止=複数の禁止席、座席指定=複数の候補席のうちどれか1つでOK）。
  function buildSecretIndexes(secretRows) {
    const forbiddenPairSet = new Set();
    const forbiddenSeatSet = new Set();
    const forbiddenSeatsMap = new Map(); // name -> [seatKey, ...]（バッジ表示用）
    const designatedSeatsMap = new Map(); // name -> [seatKey, ...]
    const adjacentRuleNames = new Set();
    const forbiddenSeatRuleNames = new Set();
    const designatedNames = new Set();

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
        designatedNames.add(r.name);
      }
    }

    // 優先処理・バッジ表示のために使う「何かしらsecret.csvに載っている人」の集合
    const priorityNames = new Set([...adjacentRuleNames, ...forbiddenSeatRuleNames, ...designatedNames]);

    return {
      forbiddenPairSet, forbiddenSeatSet, forbiddenSeatsMap, designatedSeatsMap,
      adjacentRuleNames, forbiddenSeatRuleNames, designatedNames, priorityNames,
    };
  }

  function isForbiddenPair(a, b, forbiddenPairSet) { return forbiddenPairSet.has(pairKey(a, b)); }

  // 隣接禁止の対象者を、つながっているペアごとにグループ分けし、
  // グループごとにA・B・C…の記号を割り当てる（バッジ表示用）。
  // 例: A-B、B-C が禁止なら A・B・C は同じグループとして扱う。
  function buildAdjacentGroups(secretRows) {
    const pairs = secretRows.filter(r => r.type === 'adjacent_forbidden').map(r => [r.name1, r.name2]);
    const parent = new Map();
    function find(x) {
      if (!parent.has(x)) parent.set(x, x);
      let root = x;
      while (parent.get(root) !== root) root = parent.get(root);
      let cur = x;
      while (parent.get(cur) !== root) { const next = parent.get(cur); parent.set(cur, root); cur = next; }
      return root;
    }
    function union(a, b) {
      const ra = find(a), rb = find(b);
      if (ra !== rb) parent.set(ra, rb);
    }
    pairs.forEach(([a, b]) => { find(a); find(b); union(a, b); });

    const rootOrder = [];
    const rootToMembers = new Map();
    pairs.forEach(([a, b]) => {
      [a, b].forEach(name => {
        const root = find(name);
        if (!rootToMembers.has(root)) { rootToMembers.set(root, new Set()); rootOrder.push(root); }
        rootToMembers.get(root).add(name);
      });
    });

    const letters = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
    const nameToLetter = new Map();
    rootOrder.forEach((root, i) => {
      const letter = i < letters.length ? letters[i] : `G${i + 1}`;
      rootToMembers.get(root).forEach(name => { nameToLetter.set(name, letter); });
    });
    return nameToLetter; // name -> 'A' | 'B' | ...
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

  // 候補座席のリストの中から、ランダムな順で条件に合う最初の1つを返す
  // （境界時刻ぴったりの相席になる席があれば、他に選べる席がある限り避ける）
  function findSeatAmongCandidates(candidateSeats, person, state, forbiddenSeatSet, forbiddenPairSet) {
    const candidates = shuffle(candidateSeats);
    const valid = candidates.filter(seat => canPlace(person, seat, state, forbiddenSeatSet, forbiddenPairSet));
    if (valid.length === 0) return null;
    const preferred = valid.filter(seat => !hasExactBoundaryMatch(person, slotOccupants(state[seat.key])));
    return (preferred.length > 0 ? preferred : valid)[0];
  }

  // 全15席の中から探す通常版（その他スタッフ・secret.csv対象者・フォールバック用）
  function findSeat(person, state, forbiddenSeatSet, forbiddenPairSet) {
    return findSeatAmongCandidates(SEATS, person, state, forbiddenSeatSet, forbiddenPairSet);
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
  function placeOrOverflow(person, state, forbiddenSeatSet, forbiddenPairSet, overflow, placedNames, logs, isExpectedOverflow) {
    const seat = findSeat(person, state, forbiddenSeatSet, forbiddenPairSet);
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
   *              | { type:'seat_designated', name, row, col }]
   *
   * 戻り値: { state, overflow, logs }
   *   state: { "行-列": [人 | null, 人 | null] }
   *   overflow: 配置しきれなかった人の配列
   *   logs: [{ level:'info'|'warn'|'error', message, showDialog? }]
   */
  function assignSeats(shiftRows, rookieRows, secretRows) {
    const logs = [];
    const {
      forbiddenPairSet, forbiddenSeatSet, forbiddenSeatsMap, designatedSeatsMap,
      adjacentRuleNames, forbiddenSeatRuleNames, designatedNames, priorityNames,
    } = buildSecretIndexes(secretRows);
    const adjacentGroupLetters = buildAdjacentGroups(secretRows);

    const people = shiftRows.map((r, idx) => ({
      name: r.name, start: r.start, end: r.end,
      startMin: r.startMin, endMin: r.endMin, shiftIndex: idx,
      isRookie: false, rookieRank: null,
      hasAdjacentRule: adjacentRuleNames.has(r.name),
      hasForbiddenSeatRule: forbiddenSeatRuleNames.has(r.name),
      isDesignated: designatedNames.has(r.name),
      // バッジ表示用（座席番号・グループ記号）
      designatedSeatNumbers: (designatedSeatsMap.get(r.name) || []).map(numberOfKey),
      forbiddenSeatNumbers: (forbiddenSeatsMap.get(r.name) || []).map(numberOfKey),
      adjacentGroupLetter: adjacentGroupLetters.get(r.name) || null,
    }));
    const byName = new Map(people.map(p => [p.name, p]));

    const state = {};
    for (const s of SEATS) state[s.key] = [null, null];
    const overflow = [];
    const placedNames = new Set();

    // ---- 0. 座席指定（最優先。候補が複数あればどれか1つでよい） ----
    const designatedPeople = people.filter(p => designatedSeatsMap.has(p.name));
    designatedPeople.sort(byStartTimeThenLaterRowFirst);

    for (const person of designatedPeople) {
      const candidateSeats = designatedSeatsMap.get(person.name)
        .map(key => SEATS.find(s => s.key === key))
        .filter(Boolean);
      const seat = findSeatAmongCandidates(candidateSeats, person, state, forbiddenSeatSet, forbiddenPairSet);
      if (seat) {
        seatPerson(state, seat.key, person);
        placedNames.add(person.name);
      } else {
        logs.push({
          level: 'warn', showDialog: true,
          message: `${person.name}さんの配置条件をよく確認してください（指定された座席に配置できません）`,
        });
        // 指定席がどれもダメな場合は、通常探索にフォールバックする
        placeOrOverflow(person, state, forbiddenSeatSet, forbiddenPairSet, overflow, placedNames, logs, false);
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
      placeOrOverflow(person, state, forbiddenSeatSet, forbiddenPairSet, overflow, placedNames, logs, false);
    }

    // ---- 2. secret.csv 記載スタッフ（隣接禁止・座席禁止の対象者。出勤時刻が早い順） ----
    const priorityPeople = people.filter(p => priorityNames.has(p.name) && !placedNames.has(p.name));
    priorityPeople.sort(byStartTimeThenLaterRowFirst);

    for (const person of priorityPeople) {
      placeOrOverflow(person, state, forbiddenSeatSet, forbiddenPairSet, overflow, placedNames, logs, false);
    }

    // ---- 3. その他スタッフ（出勤時刻が早い順） ----
    const others = people.filter(p => !placedNames.has(p.name));
    others.sort(byStartTimeThenLaterRowFirst);

    for (const person of others) {
      placeOrOverflow(person, state, forbiddenSeatSet, forbiddenPairSet, overflow, placedNames, logs, true);
    }

    return { state, overflow, logs };
  }

  return {
    SEATS, seatExists, ADJACENCY, assignSeats,
    buildSecretIndexes, buildAdjacentGroups, canPlace, overlaps, isForbiddenPair,
    seatByNumber, numberOfKey, numberOfSeat,
  };
})();

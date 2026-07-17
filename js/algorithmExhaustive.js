// ============================================================
// algorithmExhaustive.js
// ■2（全パターン検索・全探索backtrack）専用のファイル。
// 通常の貪欲+MRV（algorithm.js の assignSeats）とはロジックを分けて
// 見通しを良くする目的で、algorithm.js 本体から分離している。
//
// ver4.8で「自動配置を実行」の本流に組み込まれた。secret.csv対象者
// （隣接禁止・禁止席の対象者）の配置は、これ以降この■2（全探索backtrack）が
// 担当する。解が見つかった場合はそれを採用し、見つからない場合
// （証明つきで解なし、またはタイムアウト）にのみ、貪欲+MRV（assignSeats）に
// フォールバックする（呼び出し側のui.jsで制御）。
//
// 読み込み順序: 必ず algorithm.js の後に読み込むこと。
//   <script src="algorithm.js"></script>
//   <script src="algorithmExhaustive.js"></script>
// このファイルは window.SeatTool.algorithm に
// assignSeatsExhaustive / reshuffleOthers / scoreSolution を追加する形で
// 公開するため、呼び出し側（ui.js）は、この関数がどちらのファイルで定義
// されているかを意識する必要はなく、従来どおり
// window.SeatTool.algorithm.assignSeatsExhaustive(...) として呼び出せる。
// ============================================================
(function () {
  "use strict";

  if (!window.SeatTool || !window.SeatTool.algorithm) {
    throw new Error('algorithmExhaustive.js は algorithm.js の後に読み込んでください。');
  }
  const algo = window.SeatTool.algorithm;
  const {
    SEATS, canPlace, seatPerson, slotOccupants, shuffle,
    buildBaseAssignment, placeOthers,
  } = algo;

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
   *                 それぞれで走らせる前提のため短めに設定。secret.csv対象者は通常
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
   *        座席番号順の決定的な順序で配置している（secret.csv対象者側の案を
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
      // secret.csv対象者（remainingPriority）まで確定させた状態を、
      // 「その他」を配置する直前のスナップショットとして保持しておく。
      // これにより、あとから reshuffleOthers() で secret.csv対象者側の配置は
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
      // 「その他だけシャッフル」ボタン用）。これにより、secret.csv対象者側の
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
   * secret.csv対象者（隣接禁止・禁止席の対象者）側の座席はそのままに、
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

  // window.SeatTool.algorithm に追加する形で公開する（algorithm.js本体の
  // returnオブジェクトを直接書き換えるのではなく、後からプロパティを足すだけ）
  algo.assignSeatsExhaustive = assignSeatsExhaustive;
  algo.reshuffleOthers = reshuffleOthers;
  algo.scoreSolution = scoreSolution;
})();

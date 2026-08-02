// ============================================================
// algorithm.js
// 座席の定義と、優先フラグ → 新人固定席 → 教官・OJT → 固定席 → 要サポート →
// 隣接禁止 → 禁止席だけの人 → その他スタッフ の順で座席を割り当てる
// アルゴリズムを担当する。隣接禁止対象者の全探索backtrack（全パターン検索。
// 旧algorithmExhaustive.js。ver0.4.9でこのファイルに統合）と、隣接禁止の条件を
// 満たせない場合に隣接禁止の優先順位を1段階ずつ繰り上げて再探索する仕組み
// （ver0.4.11で追加。ADJACENT_ESCALATION_MAX_LEVEL・assignSeatsWithEscalation参照）、
// および禁止席だけの人も全探索backtrackで最適配置する仕組み
// （ver0.4.12で追加。findFeasibleAssignment参照。全探索側でのみ有効。
// 貪欲+MRV assignSeatsのフォールバック時は従来どおり貪欲のまま）も含む。
// CSVの形式やDOMには一切依存しない（テストしやすくするため）。
// 同日2回勤務（1人が同じ日に重ならない別々の時間帯で出勤する応援勤務）に対応
// （ver0.4.18で追加）。人物の同一性は氏名ではなく pkey（氏名|開始時刻）で判定する。
// 座席側の識別子 seat.key と紛らわしくならないよう、人物側は pkey という名前にしてある。
// ただし ojt.csv / rookie.csv / secret.csv は氏名で人を指すため、それらの照合には
// 引き続き byName（氏名 -> 人）を使う。座席の配置・復元には byKey（pkey -> 人）を使う。
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

  // 座席番号順（1〜15）に並べた配列。deterministic=true（全探索backtrackの「その他」決定的配置や
  // 「次案を表示」での切り替え時の安定表示に使用）のとき、shuffleの代わりにこの順序を使う。
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
  // 座席9番が指定されていた場合はそのまま配置する（新人固定席の既定順
  // ROOKIE_DEFAULT_SEAT_ORDER には座席9番が含まれないため、新人固定席から
  // 座席9番が候補になることは構造上ない）。実際に座席9番へ配置された
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

  // 隣接禁止（ルール1）の「隣接」の定義。ver0.4.16から全方向（上下左右＋斜め）を
  // 隣接とみなす（ver0.4.15までは同列の上下のみだった）。
  //   例: 座席1（1行1列）の隣接席 → 2・5・6
  //       座席6（2行2列）の隣接席 → 1・2・3・5・7・9・10・11
  function isAdjacentSeat(a, b) {
    if (a.key === b.key) return false;
    return Math.abs(a.row - b.row) <= 1 && Math.abs(a.col - b.col) <= 1;
  }

  // 同列で上下に隣接するかどうか（夜勤の「なるべく隣に座らせない」ソフトな
  // 優先度でのみ使用する。隣接禁止ルールそのものには使わない）
  function isSameColumnAdjacentSeat(a, b) {
    return a.col === b.col && Math.abs(a.row - b.row) === 1;
  }

  // 座席キー -> 隣接する座席キーの一覧（ルール1＝隣接禁止の判定に使用。全方向）
  const ADJACENCY = {};
  for (const s of SEATS) {
    ADJACENCY[s.key] = SEATS.filter(t => t.key !== s.key && isAdjacentSeat(s, t)).map(t => t.key);
  }

  // 座席キー -> 同列で上下に隣接する座席キーの一覧（夜勤のソフトな回避専用）
  const COLUMN_ADJACENCY = {};
  for (const s of SEATS) {
    COLUMN_ADJACENCY[s.key] = SEATS.filter(t => t.key !== s.key && isSameColumnAdjacentSeat(s, t)).map(t => t.key);
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
    const designatedSeatsMap = new Map(); // name -> [seatKey, ...]（配置に使う。silent行を含む）
    // バッジ表示専用の固定席マップ。〈ver0.5.7.5で追加〉
    // designatedSeatsMap には silent:true（ツール内部の強制配置）の分も入るため、
    // そのままバッジに使うと secret.csv に書いていない座席番号まで出てしまう。
    // designatedNames が silent を除いているのと同じ理由・同じ範囲で分けておく。
    const designatedSeatsMapForBadge = new Map(); // name -> [seatKey, ...]（silent行を除く）
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
        // designatedNames・designatedSeatsMapForBadge には加えないため
        // 「固定席」バッジにもその座席番号にも現れない
        // （夜勤の役席・GLが2名以上のとき座席10へ回る人の配置に使用）。
        if (!r.silent) {
          designatedNames.add(r.name);
          if (!designatedSeatsMapForBadge.has(r.name)) designatedSeatsMapForBadge.set(r.name, []);
          designatedSeatsMapForBadge.get(r.name).push(`${r.row}-${r.col}`);
        }
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
      designatedSeatsMapForBadge,
      supportSeatsMap, supportNames,
      adjacentRuleNames, forbiddenSeatRuleNames, designatedNames, priorityNames,
      nightGLDesignatedNames, priorityFlagMap,
    };
  }

  // 禁止席の指定により、その人が座れる座席が1つも残っていないかを判定する。
  // 〈ver0.5.7で追加。CSV入力チェックのB-7〉
  // 「禁止席の欄に15個書かれているか」を数えるのではなく、
  // 「禁止席を除いた残りの中に、その人を配置できる席が1つでも残っているか」で見る。
  // 理由は2つ。
  //  ・座席9番は通常の自動配置では使わない例外席のため、禁止席に1〜8番と10〜15番の
  //    14個を書くと残るのは9番だけとなり、実質ゼロになる。個数を数える方法では見逃す
  //  ・同じ行に同じ番号を重ねて書いた場合（1 1 2 3 …）はツール側で1つにまとめるため、
  //    書かれた個数と実際の禁止席数が一致しない
  // 固定席・要サポートで座席9番を名指ししている場合は、その明示指定により座席9番へ
  // 配置できるため、9番も残り席として数える。
  // 戻り値は残っている座席キーの配列（空配列なら座れる席がゼロ）。
  function remainingSeatKeysAfterForbidden(name, indexes) {
    const forbidden = new Set((indexes.forbiddenSeatsMap.get(name) || []));
    const explicit = new Set([
      ...(indexes.designatedSeatsMap.get(name) || []),
      ...(indexes.supportSeatsMap.get(name) || []),
    ]);
    return SEATS
      .filter(s => !AUTO_PLACEMENT_EXCLUDED_SEAT_NUMBERS.has(s.number) || explicit.has(s.key))
      .filter(s => !forbidden.has(s.key))
      .map(s => s.key);
  }

  function isForbiddenPair(a, b, forbiddenPairSet) { return forbiddenPairSet.has(pairKey(a, b)); }

  // 隣接禁止の「ペア」ごとにA・B・C…の記号を割り当て、各対象者には
  // 自分が属するペアの記号を並べたラベルを付ける（バッジ表示用）。
  // 例: 短一-短三＝ペアA、短二-短三＝ペアB
  //     → 短一:「A」、短二:「B」、短三:「AB」（AとBの両方に属する）
  // 同じ記号を持つ人同士が「隣に座ってはいけない相手」を表す。
  // 1人が4ペア以上に属する場合は記号を並べず「4以上」と表示する。
  // ペアはsecret.csvの記載順に記号を振る（同じペアの重複行は1つと数える）。
  // 0,1,2,… を A,B,C,…,Z,AA,AB,… に変換する（隣接禁止のグループ記号と、
  // ojt.csvの行ごとの記号で共通して使う。〈ver0.5.4で共通化〉）。
  // 27件目以降が2文字になるのは実運用上まず発生しない想定。
  const LETTER_CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
  function indexToLetter(index) {
    let s = '';
    let i = index + 1;
    while (i > 0) { i -= 1; s = LETTER_CHARS[i % 26] + s; i = Math.floor(i / 26); }
    return s;
  }

  // 記号の配列をバッジ2行目の文字列にする。4件以上は「4以上」にまとめる（従来どおり）。
  function formatAdjacentLabel(letters) {
    if (!letters || letters.length === 0) return null;
    return letters.length >= 4 ? '4以上' : letters.join('');
  }

  // 隣接禁止のペアを「氏名 -> [{ letter, partner }, …]」の形で返す。〈ver0.5.4で追加〉
  // buildAdjacentGroups は記号をまとめた表示用ラベルしか持たないため、
  // 「相手が本日出勤しているペアだけ記号を残す」判定ができなかった。
  // こちらはペア単位の情報を保持するので、相手の出勤有無で絞り込める。
  function buildAdjacentPairs(secretRows) {
    const seenPairs = new Set();
    const nameToPairs = new Map();
    let index = 0;
    (secretRows || []).filter(r => r.type === 'adjacent_forbidden').forEach(r => {
      const key = pairKey(r.name1, r.name2);
      if (seenPairs.has(key)) return;
      seenPairs.add(key);
      const letter = indexToLetter(index);
      index += 1;
      [[r.name1, r.name2], [r.name2, r.name1]].forEach(([name, partner]) => {
        if (!nameToPairs.has(name)) nameToPairs.set(name, []);
        nameToPairs.get(name).push({ letter, partner });
      });
    });
    return nameToPairs; // name -> [{ letter: 'A', partner: '相手の氏名' }, …]
  }

  function buildAdjacentGroups(secretRows) {
    const nameToPairs = buildAdjacentPairs(secretRows);
    const nameToLabel = new Map();
    for (const [name, entries] of nameToPairs.entries()) {
      nameToLabel.set(name, formatAdjacentLabel(entries.map(e => e.letter)));
    }
    return nameToLabel; // name -> 'A' | 'AB' | '4以上' | ...
  }

  // ============================================================
  // 教官・OJT（ojt.csv、ver0.4.7で追加）
  // ・優先順位は新人固定席・固定席の次（新人→固定席→教官・OJTの順）
  // ・教官1名につきOJT対象者は最大2名。教官とOJT一人目は同じ座席に同席する
  //   （この場合に限り、勤務時間が重なっていても同席を許可する＝通常「1座席2名
  //   までは時間が重ならない場合のみ」という制約の例外）
  // ・OJT二人目がいる場合は、教官+OJT一人目の座席とは別に、OJT二人目だけが
  //   座る座席をペアで探す（OJT二人目は他の誰かと時間が重なることは許可しない＝通常どおり）
  // ・教官が本日不在の場合、OJT対象者は同席する相手がいないためお1人で配置する
  //   （対象座席の優先順のみ流用。手動での臨時教官の割り当てが必要な旨をログに残す）
  // ・複数の教官がいる場合、教官1名・OJT2名（ペア配置）のケースを先に配置する。
  //   教官1名・OJT1名側は、既定順（15→12→8→4→3→2→1→他）で探す（ver0.4.16）。
  // ・出勤している教官が2名でOJT対象者が合計2名のとき、ojt.csv上は片方の教官が
  //   2名とも担当し、もう片方が0名という内訳であれば、教官1名・OJT1名ずつの
  //   組み合わせに自動的に組み替える（ver0.4.16）。
  // ============================================================

  // ---------- 新人（rookie.csv）の既定座席順（ver0.4.16で変更） ----------
  // 新人はこの並びの先頭から順に空きを探して固定席として配置する。
  // 通常は 新人1人目→5番、2人目→10番、3人目→6番 … となるが、優先フラグなど
  // より優先度の高いステップで先に埋まっている座席は飛ばして次の候補へ繰り下げる
  // 〈ver0.5.1で変更。それ以前は「新人N人目は配列のN番目の席のみ」を試していた〉。
  // この並びより人数が多い場合（8人目以降）は固定席を使わず通常の空席探索で配置する。
  const ROOKIE_DEFAULT_SEAT_ORDER = [5, 10, 6, 11, 7, 12, 8];

  // 単独配置（教官+OJT一人目）の既定候補順（ver0.4.16で 15→12→8→4 から拡張）。
  // ojt.csvの対象座席で指定した座席がこれより前に来る
  // （例:「12」なら 12,15,8,4,3,2,1 の順になる）。
  // ここに無い座席は「他」として通常の空席探索で配置する。
  const OJT_DEFAULT_SINGLE_ORDER = [15, 12, 8, 4, 3, 2, 1];

  // OJT二人目がいる場合のペア候補（[教官＋OJT一人目が座る側, OJT二人目が座る側]）。
  // ver0.4.16で並びを全面的に変更した。
  //   主要候補: 12,8 → 12,15 → 15,14 → 4,3 → 3,2 → 2,1
  //   （ojt.csvの対象座席で15を12より先に明示指定した教官のみ、15,14 を先に試す）
  //   その他の隣接席（本来はここまで来ないことを想定した最終候補）:
  //     12,11 → 8,7 → 11,10 → 7,6 → 6,5 → 14,13
  // この並びはレイアウトに紐づく固定値のためojt.csvには持たせずここに定数として置く。
  const OJT_PAIR_PRIMARY_12 = [[12, 8], [12, 15]];
  const OJT_PAIR_PRIMARY_15 = [[15, 14]];
  const OJT_PAIR_MAIN_TAIL = [[4, 3], [3, 2], [2, 1]];
  // 「その他扱い」の隣接席。主要候補がすべて埋まっていた場合のみ使う。
  const OJT_FALLBACK_PAIR_TAIL = [
    [12, 11], [8, 7], [11, 10], [7, 6], [6, 5], [14, 13],
  ];

  // ojt.csvの行から、判定・配置に使うインデックスを組み立てる
  // rookie.csv の行から、氏名 -> 新人度合い の索引を作る。〈ver0.4.19で追加〉
  // 保存データ読み込み後にバッジを付け直すために使う（buildOjtIndexes と同じ役割）。
  function buildRookieIndexes(rookieRows) {
    const degreeOf = new Map();
    (rookieRows || []).forEach(r => {
      if (r && typeof r.name === 'string' && !degreeOf.has(r.name)) degreeOf.set(r.name, r.degree);
    });
    return { degreeOf, rookieSeatCount: ROOKIE_DEFAULT_SEAT_ORDER.length };
  }

  function buildOjtIndexes(ojtRows) {
    const mentorOf = new Map();     // OJT対象者名 -> 教官名
    const traineesOf = new Map();   // 教官名 -> [OJT対象者名, ...]（ojt.csv記載順）
    const seatOrderOf = new Map();  // 教官名 -> [座席番号, ...]（対象座席。空配列=既定順のみ）
    const isMentor = new Set();
    const isTrainee = new Set();
    // 氏名 -> グループ記号（'A' | 'B' | …）。ojt.csvの行順で1行につき1文字を振り、
    // その行の教官とOJT対象者の全員に同じ記号を付ける。〈ver0.5.4で追加〉
    // ※この記号は「ojt.csvに書かれた通常の組み合わせ」を表す。担当教官が不在で
    //   他の教官へ振り分けた日は、記号の違う教官とOJT対象者が同席する
    //   （例: 教官Bの隣にOJT Aさん）。これは不具合ではなく、
    //   「普段はAの組み合わせの人が、今日はBの教官に付いている」という意味。
    const letterOf = new Map();
    (ojtRows || []).forEach((r, i) => {
      const letter = indexToLetter(i);
      isMentor.add(r.mentorName);
      traineesOf.set(r.mentorName, r.trainees);
      seatOrderOf.set(r.mentorName, r.seatOrder || []);
      letterOf.set(r.mentorName, letter);
      r.trainees.forEach(t => {
        mentorOf.set(t, r.mentorName);
        isTrainee.add(t);
        letterOf.set(t, letter);
      });
    });
    return { mentorOf, traineesOf, seatOrderOf, isMentor, isTrainee, letterOf };
  }

  // 対象座席（override配列）から、単独配置時の座席番号の優先順を作る
  // （overrideに書かれた座席を先頭にし、残りは既定順のまま続ける）
  function ojtSingleSeatOrder(seatOrder) {
    const overridden = seatOrder || [];
    const rest = OJT_DEFAULT_SINGLE_ORDER.filter(n => !overridden.includes(n));
    return [...overridden, ...rest];
  }

  // ojt.csvの対象座席（override配列）から、ペア配置時の候補順を作る。
  // 既定は 12,8 → 12,15 → 15,14 の順。対象座席で15を12より先に明示指定した
  // 教官のみ 15,14 を先に試す（指定なし＝既定順）。
  function ojtPairOrder(seatOrder) {
    const overridden = seatOrder || [];
    const pos12 = overridden.indexOf(12);
    const pos15 = overridden.indexOf(15);
    const prefer15 = pos15 !== -1 && (pos12 === -1 || pos15 < pos12);
    const primaries = prefer15
      ? [...OJT_PAIR_PRIMARY_15, ...OJT_PAIR_PRIMARY_12]
      : [...OJT_PAIR_PRIMARY_12, ...OJT_PAIR_PRIMARY_15];
    return [...primaries, ...OJT_PAIR_MAIN_TAIL, ...OJT_FALLBACK_PAIR_TAIL];
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
    // 同席する2人どうしが隣接禁止の相手なら同席させない。〈ver0.5.7.4で追加〉
    // 隣の席がだめで同じ机ならよい、ということはないため（canPlace側と同じ考え方）。
    if (isForbiddenPair(personA.name, personB.name, forbiddenPairSet)) return false;
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
  // allowSeat9: 呼び出し元の候補リストがojt.csvの明示指定・システム既定の候補配列に
  // 由来する場合はtrueを渡す（明示指定に由来しない候補リストではfalse＝座席9番は除外のまま）。
  function findSharedSeatInOrder(seatNumbers, personA, personB, state, forbiddenSeatSet, forbiddenPairSet, allowSeat9) {
    for (const num of seatNumbers) {
      const seat = seatByNumber(num);
      if (seat && canPlaceSharedSeat(personA, personB, seat, state, forbiddenSeatSet, forbiddenPairSet, allowSeat9)) return seat;
    }
    return null;
  }

  // 「他」用: 優先順リストにない座席も含めて探す（特に優先順位は設けないため、
  // 他の探索と同様にランダムな順で最初に見つかったものを使う）。
  // allowSeat9 を渡していないため**座席9番は対象外**。この候補は本人の明示指定に
  // 由来しないため、座席9番の除外はここでも効かせるのが正しい〈ver0.5.8でコメントを訂正。
  // 以前は「全15席から探す」と書いてあり、実際の挙動と食い違っていた〉。
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
   * 教官・OJTの配置本体。assignSeats内で新人固定席の直後・固定席の前に呼び出す。
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
      // placedNamesはpkey（氏名|開始時刻）で持つため、氏名から人を引いてから判定する。
      // 〈ver0.4.18。教官・OJT対象者は同日2回勤務の対象外という前提〉
      const available = !!mentor && !placedNames.has(mentor.pkey);
      const ownTrainees = (ojtIndexes.traineesOf.get(mentorName) || []).filter(t => {
        const person = byName.get(t);
        return !!person && !placedNames.has(person.pkey);
      });
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
        // 〈ver0.5.7.4で文言を変更〉「本日不在」と書いていたが、日勤・夜勤で座席表が
        // 分かれるため、教官が反対側（例: 教官が日勤・対象者が夜勤）に出勤している場合も
        // ここに来る。その場合「不在」は事実と違うため、この座席表にいない、という
        // 言い方に改めた（ui.js側で【日勤】【夜勤】の接頭辞が付く）。
        logs.push({
          level: 'info',
          message: `${orphanGroup.ownTrainees.join('さん、')}さんの担当教官（${orphanGroup.mentorName}さん）がこの座席表にいないため、${backup.mentorName}さんが代わりに担当します。`,
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
          logs.push({ level: 'violation', showDialog: true, message: `${traineeName}さんを配置できません。配置ルールに矛盾がある可能性があります。` });
          overflow.push(trainee);
        }
        placedNames.add(trainee.pkey);
      });
      logs.push({ level: 'warn', message: `${orphanGroup.ownTrainees.join('さん、')}さんの担当教官（${orphanGroup.mentorName}さん）がこの座席表におらず、代わりに担当できる教官も見つからなかったため、OJT対象者のみで配置しました。手動で臨時教官を割り当ててください。` });
    });

    // ---- 2.5th pass: 教官2名・OJT2名のときの組み替え（ver0.4.16で追加） ----
    // 出勤している教官が2名・OJT対象者が合計2名で、その内訳が「教官1名がOJT2名を
    // 担当・もう1名は担当なし」だった場合、教官1名・OJT1名ずつの組み合わせに
    // 組み替える（どちらのOJT対象者を移すかは指定がないため、2人目を移す）。
    (function rebalanceTwoMentorsTwoTrainees() {
      const availableEntries = entries.filter(e => e.available);
      if (availableEntries.length !== 2) return;
      const total = availableEntries.reduce((sum, e) => sum + (effectiveTrainees.get(e.mentorName) || []).length, 0);
      if (total !== 2) return;
      const loaded = availableEntries.find(e => (effectiveTrainees.get(e.mentorName) || []).length === 2);
      const empty = availableEntries.find(e => (effectiveTrainees.get(e.mentorName) || []).length === 0);
      if (!loaded || !empty) return;
      const moved = effectiveTrainees.get(loaded.mentorName).pop();
      effectiveTrainees.get(empty.mentorName).push(moved);
      logs.push({
        level: 'info',
        message: `教官2名・OJT対象者2名が出勤しているため、${moved}さんの担当を${loaded.mentorName}さんから${empty.mentorName}さんへ移し、教官1名・OJT1名ずつの組み合わせで配置します。`,
      });
    })();

    // ---- 3rd pass: 出勤している教官ごとに、実際に担当するOJT対象者
    //      （本人分＋振り分けで引き受けた分。座席の優先順は教官自身のojt.csv設定を使う）で
    //      座席配置を行う。
    //      教官1名・OJT2名（ペア配置）のケースを先に配置する（ペア配置のほうが
    //      候補の自由度が低く、先に確定させないと座席を取られてしまうため）。 ----
    const twoTraineeEntries = entries.filter(e => e.available && (effectiveTrainees.get(e.mentorName) || []).length === 2);
    const oneTraineeEntries = entries.filter(e => e.available && (effectiveTrainees.get(e.mentorName) || []).length === 1);
    const orderedEntries = [...twoTraineeEntries, ...oneTraineeEntries];

    // 教官・OJT対象者どうしに隣接禁止が設定されている組み合わせを洗い出す。
    // 〈ver0.5.7.4で追加〉
    // 教官＋OJT一人目は「同じ座席」、OJT二人目は「その隣の座席」と配置先が構造的に
    // 決まっているため、この3人の間の隣接禁止は候補を選び直しても避けられない
    // （ペア候補OJT_PAIR_*はすべて隣接席のため）。したがってここは
    // 「探し直して解決する」対象ではなく「知らせる」対象として扱う。
    function forbiddenPairsAmong(names) {
      const out = [];
      for (let i = 0; i < names.length; i++) {
        for (let j = i + 1; j < names.length; j++) {
          if (isForbiddenPair(names[i], names[j], forbiddenPairSet)) out.push([names[i], names[j]]);
        }
      }
      return out;
    }

    for (const e of orderedEntries) {
      const traineeNames = effectiveTrainees.get(e.mentorName) || [];
      const mentor = e.mentor;
      const mentorName = e.mentorName;
      const seatOrder = ojtIndexes.seatOrderOf.get(mentorName) || [];
      const singleOrder = ojtSingleSeatOrder(seatOrder);

      // ---- 教官・OJT対象者どうしの隣接禁止〈ver0.5.7.4で追加〉----
      // sharedBlocked（教官とOJT一人目が隣接禁止）は同じ座席に座らせることになるため、
      // 同席そのものをあきらめて個別配置に切り替える（canPlaceSharedSeatも同席を拒む）。
      // それ以外（OJT一人目と二人目、教官とOJT二人目）は隣の座席どうしの話で、
      // 同席をやめても隣接は避けられないため、教官・OJTの同席を優先してそのまま配置し、
      // 「置けたがルールを満たしていない」ことをオレンジ（violation）で知らせる。
      const conflicts = forbiddenPairsAmong([mentorName, ...traineeNames]);
      const sharedBlocked = traineeNames.length > 0
        && isForbiddenPair(mentorName, traineeNames[0], forbiddenPairSet);
      if (conflicts.length > 0) {
        const pairText = conflicts.map(([a, b]) => `${a}さんと${b}さん`).join('、');
        logs.push({
          level: 'violation',
          message: sharedBlocked
            ? `${pairText}は隣接禁止に指定されていますが、教官とOJT一人目は同じ座席に同席する決まりのため、両立できません。同席をやめて個別に配置しました。ojt.csvの組み合わせか、secret.csvの隣接禁止のどちらかを見直してください。`
            : `${pairText}は隣接禁止に指定されていますが、教官・OJTの同席は「教官＋OJT一人目の座席」と「その隣のOJT二人目の座席」に固定されているため、両立できません。同席を優先して隣り合う座席に配置しています。ojt.csvの組み合わせか、secret.csvの隣接禁止のどちらかを見直してください。`,
        });
      }

      if (traineeNames.length === 1) {
        const trainee = byName.get(traineeNames[0]);
        // 既定順（15→12→8→4→3→2→1→他）で探す。ver0.4.15までは、既に配置済みの
        // 教官1名・OJT2名の座席の同列1つ前を追加候補として試していたが、
        // ver0.4.16で既定順そのものを1番まで伸ばしたため、この追加候補は廃止した。
        const seat = sharedBlocked ? null : (
          findSharedSeatInOrder(singleOrder, mentor, trainee, state, forbiddenSeatSet, forbiddenPairSet, true)
          || findSharedSeatAnywhere(mentor, trainee, state, forbiddenSeatSet, forbiddenPairSet));
        if (seat) {
          seatPersonPair(state, seat.key, mentor, trainee);
          placedNames.add(mentor.pkey);
          placedNames.add(trainee.pkey);
          noteSeat9IfUsed(seat, mentorName, '教官・OJT同席（対象座席）', logs);
        } else {
          // 15席すべて埋まっている等、極めて稀なケース。教官・OJTをそれぞれ独立に配置する
          // （sharedBlockedの場合は上でオレンジのメッセージを出しているため重ねて出さない）
          if (!sharedBlocked) {
            logs.push({ level: 'warn', message: `${mentorName}さんと${traineeNames[0]}さんを同席させる座席が見つからなかったため、それぞれ個別に配置しました。` });
          }
          placeOrOverflow(mentor, state, forbiddenSeatSet, forbiddenPairSet, overflow, placedNames, logs, false, false);
          placeOrOverflow(trainee, state, forbiddenSeatSet, forbiddenPairSet, overflow, placedNames, logs, false, false);
        }
      } else if (traineeNames.length === 2) {
        const trainee1 = byName.get(traineeNames[0]);
        const trainee2 = byName.get(traineeNames[1]);
        const pairOrder = ojtPairOrder(seatOrder);
        const pair = sharedBlocked ? null
          : findOjtPairInOrder(pairOrder, mentor, trainee1, trainee2, state, forbiddenSeatSet, forbiddenPairSet);
        if (pair) {
          seatPersonPair(state, pair.seatA.key, mentor, trainee1);
          seatOjtTraineeAlone(state, pair.seatB.key, trainee2);
          placedNames.add(mentor.pkey);
          placedNames.add(trainee1.pkey);
          placedNames.add(trainee2.pkey);
          noteSeat9IfUsed(pair.seatA, mentorName, '教官・OJT同席（対象座席）', logs);
          noteSeat9IfUsed(pair.seatB, traineeNames[1], '教官・OJT同席（対象座席）', logs);
        } else {
          // ペア候補（主要6組＋その他扱いの隣接席6組の計12組）がすべて埋まっていた場合は、
          // 教官・OJT二人をまとめて同席させることにこだわらず、通常の空席探索に切り替える
          // （sharedBlockedの場合は上でオレンジのメッセージを出しているため重ねて出さない）
          if (!sharedBlocked) {
            logs.push({ level: 'warn', message: `${mentorName}さん・${traineeNames.join('さん、')}さんのペア席の候補がすべて埋まっていたため、通常の空席探索で個別に配置しました。` });
          }
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
    // 同じ座席の1人目・2人目として隣接禁止の相手と組み合わせない。〈ver0.5.7.4で追加〉
    // ADJACENCYは自分の席を含まないため、ver0.5.7.3までは「隣はだめだが同じ机はよい」
    // という抜けがあった。隣接禁止は勤務時間の重なりに関係なく常に適用する方針
    // （下のコメント参照）なので、時間帯がずれていても同じ机は避ける。
    if (occupants.length === 1 && isForbiddenPair(person.name, occupants[0].name, forbiddenPairSet)) return false;
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
  // 変わっても、この関数は無修正で追従する（実際、ver0.4.16で同列上下から全方向へ
  // 変更した際もこの関数は無修正だった）。
  function countValidSeats(person, state, forbiddenSeatSet, forbiddenPairSet) {
    let n = 0;
    for (const seat of SEATS) {
      if (canPlace(person, seat, state, forbiddenSeatSet, forbiddenPairSet)) n++;
    }
    return n;
  }

  // ============================================================
  // 事前の矛盾検知（ver0.4.7で追加）
  // 実際に配置を試みて失敗するのを待つのではなく、secret.csvの記載内容だけから
  // 「他の誰の配置状況にも関係なく、どう頑張っても配置不可能」と静的に判定できる
  // ケースを先に洗い出し、原因をピンポイントで示す。
  // ここでの判定は静的な範囲に限定する（他の人の配置状況に依存する動的な矛盾は、
  // 隣接禁止ステップ・禁止席だけの人のステップそれぞれの直前に別途チェックする
  // ＝assignSeats内とplaceForbiddenOnlyGroup内のcountValidSeats==0チェック）。
  // ============================================================
  // 〈ver0.5.7の補足〉下記のAとBは、CSV入力チェックのB-7・B-5が読み込んだCSVの
  // 内容だけで先に検出し、その時点で配置を中断するようになったため、通常はここまで
  // 到達しない（B-7は座席9番も考慮するため、Aより広い範囲を拾う）。
  // 保存データの読み込み後など、CSVチェックを通らない経路のための保険として残している。
  // userDesignatedSeatsMap（省略可）: silent:true の行を除いた固定席マップ
  // （＝secret.csv に利用者が書いた指定だけ）。〈ver0.5.8で追加〉
  // 夜勤の役席・GL2人目を座席10へ入れる指定は ui.js が silent:true で足す内部のもので、
  // secret.csv には存在しない。その人に「固定席の指定が禁止席と重複しています」と
  // 言っても直しようがないため、内部指定だけの人はここでは扱わない
  // （内部指定が通らなかったことは ui.js が別の言葉で知らせる）。
  // 省略した場合は従来どおり全件を対象にする。
  function detectStaticContradictions(byName, forbiddenSeatsMap, forbiddenSeatSet, designatedSeatsMap, supportSeatsMap, userDesignatedSeatsMap) {
    const problems = [];
    const userDesignatedMap = userDesignatedSeatsMap || designatedSeatsMap;
    const isSilentOnlyDesignated = (name) => designatedSeatsMap.has(name) && !userDesignatedMap.has(name);
    // メッセージには内部キー（"2-3"）ではなく画面と同じ座席番号を出す。〈ver0.5.8で修正〉
    const seatNumbersLabel = (seatKeys) => seatKeys.map(k => `${numberOfKey(k)}番`).join('・');

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
    function checkOwnOverlap(map, label, skipSilentOnly) {
      for (const [name, seatKeys] of map.entries()) {
        if (!byName.has(name) || seatKeys.length === 0) continue;
        if (skipSilentOnly && isSilentOnlyDesignated(name)) continue;
        const remaining = seatKeys.filter(k => !forbiddenSeatSet.has(`${name}|${k}`));
        if (remaining.length === 0) {
          problems.push(`${name}さんの${label}指定（座席${seatNumbersLabel(seatKeys)}）は、すべて本人の禁止席と重複しており、配置できません。`);
        }
      }
    }
    checkOwnOverlap(designatedSeatsMap, '固定席', true);
    checkOwnOverlap(supportSeatsMap, '要サポート', false);

    // C. 同じ1つの座席だけを候補にしている人が3人以上いる（座席の枠は2つまでのため、
    //    候補が他にない以上、確実に(人数-2)名は配置できない）
    const soleClaimants = new Map(); // seatKey -> [name, ...]
    function collectSoleClaims(map, skipSilentOnly) {
      for (const [name, seatKeys] of map.entries()) {
        if (!byName.has(name) || seatKeys.length !== 1) continue;
        if (skipSilentOnly && isSilentOnlyDesignated(name)) continue;
        const key = seatKeys[0];
        if (!soleClaimants.has(key)) soleClaimants.set(key, []);
        soleClaimants.get(key).push(name);
      }
    }
    collectSoleClaims(designatedSeatsMap, true);
    collectSoleClaims(supportSeatsMap, false);
    for (const [seatKey, names] of soleClaimants.entries()) {
      const uniqueNames = [...new Set(names)];
      if (uniqueNames.length > 2) {
        const num = numberOfKey(seatKey);
        problems.push(`座席${num}番だけを候補にしている方が${uniqueNames.length}名（${uniqueNames.join('・')}）いますが、1座席の枠は2つまでのため、少なくとも${uniqueNames.length - 2}名は配置できません。`);
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
  // deterministic=true（ver0.4.8で追加。全探索の「その他」決定的配置、および
  // 「次案を表示」での切り替え時の表示安定化に使用）の場合はshuffleせず、渡された順序
  // （＝座席番号順）のまま先頭から探す。省略時はfalse（従来どおりランダム）。
  function findSeatAmongCandidates(candidateSeats, person, state, forbiddenSeatSet, forbiddenPairSet, avoidAdjacency, deterministic) {
    const candidates = deterministic ? candidateSeats.slice() : shuffle(candidateSeats);
    let valid = candidates.filter(seat => canPlace(person, seat, state, forbiddenSeatSet, forbiddenPairSet));
    if (valid.length === 0) return null;
    if (avoidAdjacency) {
      const nonAdjacent = valid.filter(seat => !COLUMN_ADJACENCY[seat.key].some(adjKey => slotOccupants(state[adjKey]).length > 0));
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

  // 「secret.csvのルールをすべて外しても、この人が座れる席が残っていないか」。
  // 〈ver0.5.8で追加〉席そのものが足りないだけなのに
  // 「配置ルールに矛盾がある可能性があります。secret.csvの条件を確認してください。」と
  // 出してしまうと、直しようのない指摘になる（しかもダイアログが人数分出る）。
  // 空の集合で canPlace を数え直せば、容量（枠の空き・勤務時間の重なり）だけの判定になる。
  const NO_RULES = new Set();
  function seatsAvailableIgnoringRules(person, state) {
    return countValidSeats(person, state, NO_RULES, NO_RULES);
  }

  // 空席を探して座らせる。見つからなければログを残して「あふれ」に入れる。
  // isExpectedOverflow=true: 通常のあふれ（情報ログのみ）
  // isExpectedOverflow=false: 本来起きないはずの配置ルール矛盾（オレンジ+ダイアログ）
  //   ただしルールを全部外しても座れない＝単に席が足りない場合は、通常のあふれに倒す
  //   〈ver0.5.8〉。あふれ欄に出るので気づける（仕様.md §5）。
  function placeOrOverflow(person, state, forbiddenSeatSet, forbiddenPairSet, overflow, placedNames, logs, isExpectedOverflow, avoidAdjacency, deterministic) {
    const seat = findSeat(person, state, forbiddenSeatSet, forbiddenPairSet, avoidAdjacency, deterministic);
    if (seat) {
      seatPerson(state, seat.key, person);
    } else if (isExpectedOverflow || seatsAvailableIgnoringRules(person, state) === 0) {
      overflow.push(person);
    } else {
      logs.push({
        level: 'violation', showDialog: true,
        message: `${person.name}さんを配置できません。配置ルールに矛盾がある可能性があります。secret.csvの条件を確認してください。`,
      });
      overflow.push(person);
    }
    placedNames.add(person.pkey);
  }

  // ============================================================
  // 隣接禁止の繰り上げ段階（ver0.4.11で追加。ver0.4.16で優先順位と上限を変更）
  // 隣接禁止対象者を配置するタイミング（隣接禁止ステップ）を、失敗するたびに
  // 1段階ずつ前へ繰り上げて再探索するための定義。優先フラグ・新人固定席・
  // 教官・OJTより前には繰り上げない（上限は段階2＝教官・OJTの直後）。
  //   段階0（既定）: 優先フラグ → 新人固定席 → 教官・OJT → 固定席 → 要サポート → 隣接禁止 → 禁止席だけの人 → その他
  //   段階1:         優先フラグ → 新人固定席 → 教官・OJT → 固定席 → 隣接禁止 → 要サポート → 禁止席だけの人 → その他
  //   段階2（上限）: 優先フラグ → 新人固定席 → 教官・OJT → 隣接禁止 → 固定席 → 要サポート → 禁止席だけの人 → その他
  // ・「隣接禁止対象者」= secret.csvの隣接禁止に載っている人（禁止席も併せ持つ人を含む）。
  // ・「禁止席だけの人」= 禁止席だけに載っている人。ver0.4.10までは隣接禁止対象者と
  //   一括で全探索していたが、ver0.4.11からは分離し、要サポートの後（繰り上げ時も同位置）に
  //   配置する。ver0.4.12からは、この分離した枠の中で改めて全探索backtrackを行う
  //   （findFeasibleAssignment。解が1つ見つかった時点で確定し、採点はしない）。
  //   MRV貪欲は、解なし・時間切れのときのフォールバックとしてのみ使う。
  // ・繰り上げにより隣接禁止ステップが固定席・要サポートより先に来た場合、対象者が
  //   固定席・要サポートの指定席を持っていれば、隣接禁止ステップ内でまずその指定席を
  //   優先候補として試し、使えなければ指定席の条件を外して隣接禁止条件を満たせる座席を探す。
  const ADJACENT_ESCALATION_MAX_LEVEL = 2;

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
   *     - secret.csvで「夜勤GL席」に固定席されている人に、「夜勤GL席」バッジを
   *       表示するためのフラグが付く（〈ver0.5.6で変更〉それ以前は「夜勤GL枠に
   *       選ばれず座席1〜15に回った人」を示すバッジだった）
   *   options.adjacentEscalationLevel（ver0.4.11で追加）: 隣接禁止ステップの繰り上げ段階
   *   （0〜ADJACENT_ESCALATION_MAX_LEVEL。省略時0＝従来と同じ位置）。
   *
   * 戻り値: { state, overflow, logs }
   *   state: { "行-列": [人 | null, 人 | null] }
   *   overflow: 配置しきれなかった人の配列
   *   logs: [{ level:'info'|'warn'|'error', message, showDialog? }]
   */
  /**
   * assignSeats（貪欲+MRV）と assignSeatsExhaustive（全探索backtrack。ver0.4.7で追加）の
   * 両方から呼び出される共通の下ごしらえ処理。
   * 優先フラグと、繰り上げ段階に応じた「隣接禁止ステップより前の各ステップ」までを
   * 確定させ、残った隣接禁止対象者（adjacencyPeople）をどう配置するかは
   * 呼び出し側（貪欲MRV or 全探索backtrack）に委ねる。
   * 隣接禁止ステップの後に回るステップ（繰り上げで後回しになったステップ＋
   * 禁止席だけの人）は、戻り値の runPostSteps(ctx, deterministic) で実行する
   * （全探索側では解ごとに実行するため、関数として返す）。
   */
  function buildBaseAssignment(shiftRows, rookieRows, secretRows, options) {
    const nightContext = !!(options && options.nightContext);
    const rawLevel = (options && options.adjacentEscalationLevel) || 0;
    const escalationLevel = Math.max(0, Math.min(ADJACENT_ESCALATION_MAX_LEVEL, rawLevel));
    const ojtIndexes = buildOjtIndexes(options && options.ojtRows);
    const logs = [];
    const {
      forbiddenPairSet, forbiddenSeatSet, forbiddenSeatsMap, designatedSeatsMap,
      designatedSeatsMapForBadge,
      supportSeatsMap, supportNames,
      adjacentRuleNames, forbiddenSeatRuleNames, designatedNames, priorityNames,
      nightGLDesignatedNames, priorityFlagMap,
    } = buildSecretIndexes(secretRows);
    const adjacentGroupLetters = buildAdjacentGroups(secretRows);

    const people = shiftRows.map((r, idx) => ({
      name: r.name, start: r.start, end: r.end,
      // 同日2回勤務を区別する識別子。〈ver0.4.18で追加〉
      // 通常はcsv.jsが付与する「氏名|開始時刻」。保存データの復元や、
      // pkeyを持たない古い呼び出し元から渡された場合はここで補完する。
      pkey: r.pkey || `${r.name}|${r.start}`,
      startMin: r.startMin, endMin: r.endMin, shiftIndex: idx,
      // 残業の種別（'' / 'OP' / 'GL'）。〈ver0.5.5〉真偽値に潰すと種別が失われ、
      // 座席表でOP残業とGL残業を描き分けられなくなるため、文字列のまま持ち回る。
      frontOT: r.frontOT || '', backOT: r.backOT || '',
      // 役割（役席/GL/OP）。座席グリッドに来るのは基本OPだが、夜勤では役席・GLの
      // 2人目以降も座席に配置されるため、役割を保持しておく（夜勤GL枠が空になって
      // いないかの違反チェックで「座席側に夜勤の役席・GLがいるか」の判定に使う）
      role: r.role || 'OP',
      isRookie: false, rookieRank: null, rookieDegree: null,
      hasAdjacentRule: adjacentRuleNames.has(r.name),
      hasForbiddenSeatRule: forbiddenSeatRuleNames.has(r.name),
      isDesignated: designatedNames.has(r.name),
      // バッジ表示用（座席番号・グループ記号）
      // 〈ver0.5.7.5〉silent行（夜勤GL2人目の座席10）を含む designatedSeatsMap ではなく、
      // secret.csvの記載だけを持つ designatedSeatsMapForBadge を使う。
      designatedSeatNumbers: (designatedSeatsMapForBadge.get(r.name) || []).map(numberOfKey),
      forbiddenSeatNumbers: (forbiddenSeatsMap.get(r.name) || []).map(numberOfKey),
      adjacentGroupLetter: adjacentGroupLetters.get(r.name) || null,
      // 夜勤専用: 「夜勤GL席」に固定席されている人（バッジ表示用。〈ver0.5.6〉
      // 夜勤GL枠に選ばれたかどうかは問わない）
      hasNightGLDesignation: nightContext && nightGLDesignatedNames.has(r.name),
      // 教官・OJT（ojt.csv）バッジ表示用
      isOjtMentor: ojtIndexes.isMentor.has(r.name),
      isOjtTrainee: ojtIndexes.isTrainee.has(r.name),
      ojtMentorName: ojtIndexes.mentorOf.get(r.name) || null,
      ojtTraineeNames: ojtIndexes.traineesOf.get(r.name) || [],
      // ojt.csvの行ごとの記号（教官・OJTバッジ2行目）。〈ver0.5.4で追加〉
      ojtGroupLetter: (ojtIndexes.letterOf && ojtIndexes.letterOf.get(r.name)) || null,
      // 要サポート（secret.csv「要サポート」種別）バッジ表示用
      isSupport: supportNames.has(r.name),
      supportSeatNumbers: (supportSeatsMap.get(r.name) || []).map(numberOfKey),
      // 優先フラグ（secret.csv5列目）。数値は配置順の決定・デバッグ・参照用に保持し、
      // hasPriorityFlagは「優先」バッジの表示用（数値は表示しない）
      priorityFlag: priorityFlagMap.has(r.name) ? priorityFlagMap.get(r.name) : null,
      hasPriorityFlag: priorityFlagMap.has(r.name),
    }));
    // 氏名 -> オブジェクト。ojt.csv / rookie.csv / secret.csv は氏名で人を指すため、
    // それらの照合には引き続きこのMapを使う。〈同日2回勤務では後の1件が前を上書き
    // するが、2回勤務者はこれらのCSVの対象外という前提のため実害はない。ver0.4.18〉
    const byName = new Map(people.map(p => [p.name, p]));
    // pkey（氏名|開始時刻）-> オブジェクト。〈ver0.4.18で追加〉
    // 同日2回勤務でも1件ずつ別人として引ける。座席の配置・復元にはこちらを使う。
    const byKey = new Map(people.map(p => [p.pkey, p]));

    // ---- 事前の矛盾検知（静的にわかる範囲）。配置を試みる前にまとめて報告する ----
    const staticProblems = detectStaticContradictions(
      byName, forbiddenSeatsMap, forbiddenSeatSet, designatedSeatsMap, supportSeatsMap,
      designatedSeatsMapForBadge
    );
    staticProblems.forEach(message => logs.push({ level: 'violation', showDialog: true, message }));

    const state = {};
    for (const s of SEATS) state[s.key] = [null, null];
    const overflow = [];
    const placedNames = new Set();
    // ステップ関数が共通で読み書きする状態のまとまり。全探索側では解ごとに
    // これを複製して runPostSteps に渡すため、各ステップは必ず ctx 経由で
    // state / overflow / logs / placedNames を触る（外側の変数を直接触らない）。
    const baseCtx = { state, overflow, logs, placedNames };

    // 優先フラグが同数値のときの並び替えに使う「配置ルール順」
    // （新人 > 教官・OJT > 固定席 > 要サポート > その他。ver0.4.16で順序変更）
    const rookieNameSet = new Set(rookieRows.map(r => r.name));
    function ruleRank(name) {
      if (rookieNameSet.has(name)) return 0;
      if (ojtIndexes.isMentor.has(name) || ojtIndexes.isTrainee.has(name)) return 1;
      if (designatedSeatsMap.has(name)) return 2;
      if (supportNames.has(name)) return 3;
      return 4;
    }

    // ---- -1. 優先フラグ（secret.csv5列目。全ルールの中で最優先。数値が小さいほど
    //      優先。同数値の場合は「配置ルール順」→出勤時刻順で並べる） ----
    // 繰り上げ段階に関わらず、常に最初に実行する（優先フラグは動かさない）。
    // 対象者が固定席・要サポートの指定を持っていればその候補座席（入力順）を使い、
    // 何も持っていなければ通常の空席探索で配置する。
    function stepPriorityFlag(ctx) {
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
          ? findSeatInGivenOrder(candidateSeats, person, ctx.state, forbiddenSeatSet, forbiddenPairSet)
          : null;
        if (seat) {
          seatPerson(ctx.state, seat.key, person);
          ctx.placedNames.add(person.pkey);
          const ruleLabel = (designatedSeatsMap.get(person.name) || []).includes(seat.key) ? '固定席' : '要サポート';
          noteSeat9IfUsed(seat, person.name, ruleLabel, ctx.logs);
        } else {
          // 固定席・要サポートの指定がない（または指定席がすべて埋まっていた）場合は
          // 通常の空席探索にフォールバックする
          placeOrOverflow(person, ctx.state, forbiddenSeatSet, forbiddenPairSet, ctx.overflow, ctx.placedNames, ctx.logs, false, nightContext);
        }
      }
    }
    stepPriorityFlag(baseCtx);

    // ---- 新人（固定席）の対象者・順位の決定 ----
    // 「本日出勤している人」を新人として扱う。〈ver0.5.5で変更〉
    // ver0.5.4までは「優先フラグでまだ配置されていない人」に限っていたため、優先フラグ持ちの
    // 新人だけバッジが付かず、そのぶん後続の順位が繰り上がっていた。他のバッジ（固定席・
    // 要サポート・禁止席・隣接禁止・夜勤GL席・教官・OJT）はいずれも「CSVに名前があるか」だけで
    // 表示が決まるため、新人バッジもそれに揃える。
    // isRookie / rookieRank（バッジ表示用）はここで一度だけ確定させる。繰り上げの最終段階で
    // 新人固定席ステップが隣接禁止ステップより後に回った場合でも、順位（何番席相当か）は
    // 変わらないようにするため、実際の配置とは切り離してここで決めておく。
    // なお、既に配置済みの人は下の stepRookies 側でスキップされるため二重配置は起きない。
    const matchedRookieRows = rookieRows.filter(n => !!byName.get(n.name));
    // rookieDegree はバッジ順位の再計算（保存データ読み込み後）に使うため保持する〈ver0.4.19〉
    matchedRookieRows.forEach(n => {
      const person = byName.get(n.name);
      person.isRookie = true;
      person.rookieDegree = n.degree;
    });
    // 〈ver0.5.8で変更〉以前は `{ ...byName.get(n.name), degree }` と**人のコピー**を作り、
    // stepRookies がそのコピーを座席に置いていた。rookieRank だけは実物にも代入していたため
    // 実害は出ていなかったが、以後 people に項目を足すと「座席にいる新人だけ古い内容」という
    // 事故になる。並び替え用の情報は別に持ち、座席に置くのは必ず people の実物にする。
    const rookieCandidates = matchedRookieRows.map(n => ({ person: byName.get(n.name), degree: n.degree }));
    rookieCandidates.sort((a, b) => {
      if (a.degree !== b.degree) return a.degree - b.degree; // 数値が小さいほど新人=優先
      return b.person.shiftIndex - a.person.shiftIndex; // 同数値: shift.csvで後ろの行がより新人
    });
    // 〈ver0.5.5〉優先フラグなどで既に配置済みの新人も、この上位7名の枠を1つ使う。
    // 順位（新人1〜7）と新人固定席の対象者を同じ集合にそろえるため（説明のしやすさを優先）。
    // 新人が7名を超えない運用であれば実際の配置結果に差は出ない。
    const rookieTop = rookieCandidates.slice(0, ROOKIE_DEFAULT_SEAT_ORDER.length).map(e => e.person);
    rookieTop.forEach((person, i) => { person.rookieRank = i + 1; });

    // ---- 0. 新人（固定席）の配置 ----
    // 優先フラグで既に配置された新人、および繰り上げの最終段階で隣接禁止ステップが先に
    // 来た場合に隣接禁止側で既に配置された新人は、ここでは飛ばす
    // （rookieRankバッジは付いたまま。〈ver0.5.5〉優先フラグ持ちも同様の扱いになった）。
    //
    // 〈ver0.5.1で変更〉新人固定席は ROOKIE_DEFAULT_SEAT_ORDER の先頭から順に空きを探す。
    // ver0.5.0までは「新人N人目は配列のN番目の席のみ」を試していたため、優先フラグなど
    // より優先度の高いステップで先に埋まっていると即座に諦めて通常探索へ回っていた。
    // 新人1が5番に座れない場合は10番、次は6番…と繰り下げ、後続の新人はその残りから
    // 同じく先頭順で探す。rookieRank（バッジ表示）は実際に座った席とは無関係に
    // 上流で確定済みのため、繰り下げが起きても「新人1」「新人2」の表示は変わらない。
    function stepRookies(ctx) {
      const fallbackQueue = [];
      rookieTop.forEach(person => {
        if (ctx.placedNames.has(person.pkey)) return;
        // 新人固定席は「新人はこの座席群に座る」と明示的に決まっている座席のため、
        // 仮に座席9番が対象になった場合でも明示指定として扱う（allowSeat9=true）。
        let placed = false;
        for (const seatNumber of ROOKIE_DEFAULT_SEAT_ORDER) {
          const targetSeat = seatByNumber(seatNumber);
          if (!targetSeat) continue;
          if (!canPlace(person, targetSeat, ctx.state, forbiddenSeatSet, forbiddenPairSet, true)) continue;
          seatPerson(ctx.state, targetSeat.key, person);
          ctx.placedNames.add(person.pkey);
          noteSeat9IfUsed(targetSeat, person.name, '新人固定席', ctx.logs);
          placed = true;
          break;
        }
        if (!placed) {
          // 新人固定席がすべて埋まっている／座れない場合のみ警告する。
          // 現実には新人が同時に7人発生することは想定していないため、
          // ここに来る場合は入力データの矛盾を疑う。
          ctx.logs.push({
            level: 'violation', showDialog: true,
            message: `${person.name}さんの配置条件をよく確認してください（新人固定席 ${ROOKIE_DEFAULT_SEAT_ORDER.join('・')}番 のいずれにも配置できません）`,
          });
          fallbackQueue.push(person);
        }
      });
      // 固定席に座れなかった新人は、通常探索で優先的に配置する（本来は起きない想定のため矛盾扱い）
      for (const person of fallbackQueue) {
        placeOrOverflow(person, ctx.state, forbiddenSeatSet, forbiddenPairSet, ctx.overflow, ctx.placedNames, ctx.logs, false, nightContext);
      }
    }

    // ---- 1. 固定席（複数指定されている場合はsecret.csvに入力した順が優先順位になる） ----
    // 候補座席が少ない人ほど融通が利かないため先に配置する（同数の場合は出勤時刻が早い順）。
    // 例えば候補1つの人と候補3つの人が同じ座席を希望している場合、候補3つの人を
    // 先に配置してしまうと、候補1つの人が行き場を失ってしまう可能性があるため。
    // 優先フラグ・新人など、より優先順位の高いステップで既に配置済みの人は除く。
    function stepDesignated(ctx) {
      const designatedPeople = people.filter(p => designatedSeatsMap.has(p.name) && !ctx.placedNames.has(p.pkey));
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
        const seat = findSeatInGivenOrder(candidateSeats, person, ctx.state, forbiddenSeatSet, forbiddenPairSet);
        if (seat) {
          seatPerson(ctx.state, seat.key, person);
          ctx.placedNames.add(person.pkey);
          noteSeat9IfUsed(seat, person.name, '固定席', ctx.logs);
        } else {
          // silent:true（ui.jsが足す夜勤の座席10）だけしか指定を持たない人には出さない。
          // 〈ver0.5.8〉secret.csv に固定席を書いていないため、この文面では
          // どこを直せばよいのか分からない。内部指定が通らなかったことは
          // ui.js 側が「座席10へ入れられなかった」と正しい言葉で知らせる。
          if (designatedSeatsMapForBadge.has(person.name)) {
            ctx.logs.push({
              level: 'violation', showDialog: true,
              message: `${person.name}さんの配置条件をよく確認してください（指定された座席に配置できません）`,
            });
          }
          // 指定席がどれもダメな場合は、通常探索にフォールバックする
          placeOrOverflow(person, ctx.state, forbiddenSeatSet, forbiddenPairSet, ctx.overflow, ctx.placedNames, ctx.logs, false, nightContext);
        }
      }
    }

    // ---- 2. 教官・OJT（ojt.csv） ----
    function stepOjt(ctx) {
      assignMentorOjt(byName, ojtIndexes, ctx.state, forbiddenSeatSet, forbiddenPairSet, ctx.overflow, ctx.placedNames, ctx.logs);
    }

    // ---- 3. 要サポート（固定席と同じ入力・並び順のルール。専用の座席指定がある点も同じ） ----
    // より先に実行されたステップで既に配置済みの人は除く。
    function stepSupport(ctx) {
      const supportPeople = people.filter(p => supportSeatsMap.has(p.name) && !ctx.placedNames.has(p.pkey));
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
        const seat = findSeatInGivenOrder(candidateSeats, person, ctx.state, forbiddenSeatSet, forbiddenPairSet);
        if (seat) {
          seatPerson(ctx.state, seat.key, person);
          ctx.placedNames.add(person.pkey);
          noteSeat9IfUsed(seat, person.name, '要サポート', ctx.logs);
        } else {
          ctx.logs.push({
            level: 'violation', showDialog: true,
            message: `${person.name}さんの配置条件をよく確認してください（要サポートで指定された座席に配置できません）`,
          });
          placeOrOverflow(person, ctx.state, forbiddenSeatSet, forbiddenPairSet, ctx.overflow, ctx.placedNames, ctx.logs, false, nightContext);
        }
      }
    }

    // 汎用backtrack探索（禁止席だけの人の最適配置に使用。ver0.4.12で追加）。
    // buildBaseAssignment の内側に置いてあるが、外側の変数は一切参照せず引数だけで
    // 完結している（＝クロージャに依存しない純粋関数）。
    // remainingの全員を、state上の空き座席にcanPlace()を満たす形ですべて配置できる
    // 組み合わせを、MRVで枝刈りしながら探す。1つでも見つかれば直ちに打ち切る
    // （「実行可能かどうか」の判定と配置が目的で、複数解を比較する必要はないため）。
    // stateは探索中に破壊的に変更されるが、呼び出し後は必ず元の状態に戻る。
    // clock: { startTime, timeBudgetMs } を呼び出し元と共有すると、複数回呼んでも
    // 合計の探索時間がbudgetを超えないようにできる。
    // 戻り値: { solution: Map|null（name -> seatKey）, timedOut, bestPartial }
    function findFeasibleAssignment(remaining, state, seatsOrder, forbiddenSeatSet, forbiddenPairSet, clock) {
      let timedOut = false;
      let found = null;
      let bestPartial = null;

      function search(rem, assignedMap) {
        if (found || timedOut) return;
        if (Date.now() - clock.startTime > clock.timeBudgetMs) { timedOut = true; return; }
        if (rem.length === 0) { found = new Map(assignedMap); return; }

        let totalEmptySlots = 0;
        for (const seat of seatsOrder) totalEmptySlots += 2 - slotOccupants(state[seat.key]).length;
        if (rem.length > totalEmptySlots) {
          if (!bestPartial || assignedMap.size > bestPartial.placedCount) {
            bestPartial = { placedCount: assignedMap.size, unplacedNames: rem.map(p => p.name) };
          }
          return;
        }

        let bestIdx = -1, bestCount = Infinity, bestCandidates = null;
        for (let i = 0; i < rem.length; i++) {
          const cands = seatsOrder.filter(seat => canPlace(rem[i], seat, state, forbiddenSeatSet, forbiddenPairSet));
          if (cands.length < bestCount) {
            bestCount = cands.length; bestIdx = i; bestCandidates = cands;
            if (bestCount === 0) break;
          }
        }
        if (bestCount === 0) {
          if (!bestPartial || assignedMap.size > bestPartial.placedCount) {
            bestPartial = { placedCount: assignedMap.size, unplacedNames: rem.map(p => p.name) };
          }
          return;
        }

        const person = rem[bestIdx];
        const rest = rem.slice(0, bestIdx).concat(rem.slice(bestIdx + 1));
        for (const seat of bestCandidates) {
          seatPerson(state, seat.key, person);
          assignedMap.set(person.pkey, seat.key);
          search(rest, assignedMap);
          assignedMap.delete(person.pkey);
          const slots = state[seat.key];
          const idx = slots.indexOf(person);
          if (idx !== -1) slots[idx] = null;
          if (found || timedOut) return;
        }
      }

      search(remaining, new Map());
      return { solution: found, timedOut, bestPartial };
    }

    // ---- 禁止席だけの人（隣接禁止には載っていない人）の配置 ----
    // どの繰り上げ段階でも、要サポートの後・その他の前に実行する。
    // mode='greedy'（既定。assignSeatsの貪欲フォールバックで使用）:
    //   ver0.4.10までと同じ、「最も制約がきつい人（＝今この時点で座れる座席が最も少ない人）」
    //   から順に置いていくMRV貪欲。1手ごとには最適でも、全体として実は別の組み合わせなら
    //   全員置けた、というケースを取りこぼす可能性がある。
    // mode='exhaustive'（ver0.4.12で追加。全探索側で使用）:
    //   まずfindFeasibleAssignmentで全員を配置できる組み合わせが存在するか
    //   backtrackで探し、見つかればそれをそのまま採用する（＝全員配置できる組み合わせが
    //   1つでも存在する限り、必ず全員配置できる。隣接禁止対象者と同様に最適）。
    //   clockで指定した時間内に見つからなかった場合（本当に解なし、またはタイムアウト）は
    //   greedyモードにフォールバックし、その旨をlogsに積む。
    // seatsOrder（省略可。mode='exhaustive'のときのみ使用。既定はSEATS＝座席番号順）:
    //   backtrackが座席を試す順序。既定の座席番号順だと毎回同じ組み合わせが
    //   見つかるため、シャッフル機能（ver0.4.15）ではshuffle(SEATS)を渡し、
    //   複数の有効な組み合わせがある場合にランダムに切り替わるようにする。
    function placeForbiddenOnlyGroup(ctx, deterministic, mode, clock, seatsOrder) {
      const group = people.filter(p =>
        p.hasForbiddenSeatRule && !p.hasAdjacentRule && !ctx.placedNames.has(p.pkey));
      if (group.length === 0) return;

      // ---- 事前の矛盾検知（動的な範囲）----
      // ここまでの配置が確定した状態で、この時点で既に座れる座席がゼロの人が
      // いないかを、実際に配置を試みる前に洗い出す。
      for (const person of group) {
        if (countValidSeats(person, ctx.state, forbiddenSeatSet, forbiddenPairSet) !== 0) continue;
        // ルールを全部外しても座れない＝席そのものが足りないだけなので、
        // secret.csv を疑わせない（通常のあふれとして扱う）。〈ver0.5.8〉
        if (seatsAvailableIgnoringRules(person, ctx.state) === 0) continue;
        ctx.logs.push({
          level: 'violation', showDialog: true,
          message: `${person.name}さんは、この時点で座れる座席がありません（禁止席の条件と、既に確定している他の方の座席の組み合わせにより配置不可能です）。secret.csvの条件を確認してください。`,
        });
      }

      function placeGreedy(g) {
        let remaining = g;
        while (remaining.length > 0) {
          let best = null;
          let bestCount = Infinity;
          for (const person of remaining) {
            const cnt = countValidSeats(person, ctx.state, forbiddenSeatSet, forbiddenPairSet);
            if (best === null || cnt < bestCount
              || (cnt === bestCount && byStartTimeThenLaterRowFirst(person, best) < 0)) {
              best = person;
              bestCount = cnt;
            }
          }
          remaining = remaining.filter(p => p !== best);
          placeOrOverflow(best, ctx.state, forbiddenSeatSet, forbiddenPairSet, ctx.overflow, ctx.placedNames, ctx.logs, false, nightContext, deterministic);
        }
      }

      if (mode !== 'exhaustive') {
        placeGreedy(group);
        return;
      }

      const result = findFeasibleAssignment(group, ctx.state, seatsOrder || SEATS, forbiddenSeatSet, forbiddenPairSet, clock);
      if (result.solution) {
        for (const [pkey, seatKey] of result.solution.entries()) {
          seatPerson(ctx.state, seatKey, byKey.get(pkey));
          ctx.placedNames.add(pkey);
        }
        return;
      }
      // 全員を配置できる組み合わせが見つからなかった（証明つきで解なし、または
      // 制限時間内に見つからなかった）ため、貪欲法にフォールバックする
      const reason = result.timedOut
        ? '制限時間内に全員を配置できる組み合わせが見つからなかった'
        : '禁止席の条件をすべて満たす組み合わせが見つからなかった';
      const partialNote = result.bestPartial
        ? `（最も惜しい組み合わせでも配置できなかった対象者: ${result.bestPartial.unplacedNames.join('、')}さん）`
        : '';
      ctx.logs.push({
        level: 'warn', showDialog: true,
        message: `禁止席だけの人について全探索を行いましたが、${reason}ため${partialNote}、通常の配置方法（貪欲法）で配置しました。secret.csvの条件を確認してください。`,
      });
      placeGreedy(group);
    }


    // ---- 繰り上げ段階に応じたステップの前後振り分け ----
    // orderedSteps のうち、後ろから escalationLevel 個が「隣接禁止ステップの後」に回る。
    //   段階0: 前=[新人, 教官OJT, 固定席, 要サポート] / 後=[]
    //   段階1: 前=[新人, 教官OJT, 固定席] / 後=[要サポート]
    //   段階2: 前=[新人, 教官OJT] / 後=[固定席, 要サポート]
    // （教官・OJTより前には繰り上げないため、段階2が上限）
    const orderedSteps = [stepRookies, stepOjt, stepDesignated, stepSupport];
    const splitIndex = orderedSteps.length - escalationLevel;
    const preSteps = orderedSteps.slice(0, splitIndex);
    const postSteps = orderedSteps.slice(splitIndex);
    for (const step of preSteps) step(baseCtx);

    // 繰り上げで後回しになったステップ（禁止席だけの人は含まない）だけを実行する。
    // 全探索側で、「禁止席だけの人を配置する直前」のスナップショットを
    // 取るために、placeForbiddenOnlyGroupと分けて呼べるようにしている（ver0.4.15）。
    function runPostponedSteps(ctx) {
      for (const step of postSteps) step(ctx);
    }

    // 隣接禁止ステップの後に回るステップ（繰り上げで後回しになったステップ＋
    // 禁止席だけの人）をまとめて実行する。全探索側では解ごとに呼ぶため関数で返す。
    // forbiddenMode: 'greedy'（既定）| 'exhaustive'。'exhaustive'のときはclock
    // （{startTime, timeBudgetMs}）が必要（全探索側から共有クロックを渡す）。
    function runPostSteps(ctx, deterministic, forbiddenMode, clock) {
      runPostponedSteps(ctx);
      placeForbiddenOnlyGroup(ctx, deterministic, forbiddenMode, clock);
    }



    // ---- 隣接禁止対象者と、その優先候補座席（固定席・要サポートの指定席） ----
    // ここまでのステップで配置されなかった隣接禁止対象者。これをどう配置するかは
    // 呼び出し側に委ねる（assignSeatsなら貪欲+MRV、assignSeatsExhaustiveなら全探索backtrack）。
    const adjacencyPeople = people.filter(p => p.hasAdjacentRule && !placedNames.has(p.pkey));
    // 繰り上げにより固定席・要サポートのステップが後回しになった場合、対象者の
    // 指定席は隣接禁止ステップ内で「まず試す優先候補」として扱う（使えなければ
    // 指定席の条件を外して探索する）。noteSeat9IfUsed用のルール名も併せて持つ。
    const preferredSeatsOf = new Map(); // name -> [seatオブジェクト, ...]（固定席→要サポートの入力順）
    const preferredLabelOf = new Map(); // name -> Map(seatKey -> '固定席' | '要サポート')
    for (const p of adjacencyPeople) {
      const labelMap = new Map();
      (supportSeatsMap.get(p.name) || []).forEach(k => labelMap.set(k, '要サポート'));
      (designatedSeatsMap.get(p.name) || []).forEach(k => labelMap.set(k, '固定席'));
      const keys = [
        ...(designatedSeatsMap.get(p.name) || []),
        ...(supportSeatsMap.get(p.name) || []),
      ];
      const seats = [];
      const seen = new Set();
      for (const key of keys) {
        if (seen.has(key)) continue;
        seen.add(key);
        const seat = SEATS.find(s => s.key === key);
        if (seat) seats.push(seat);
      }
      if (seats.length > 0) {
        preferredSeatsOf.set(p.name, seats);
        preferredLabelOf.set(p.name, labelMap);
      }
    }

    return {
      state, overflow, logs, placedNames, people, byName, byKey,
      forbiddenSeatSet, forbiddenPairSet, priorityNames,
      adjacencyPeople, preferredSeatsOf, preferredLabelOf,
      runPostSteps, runPostponedSteps, placeForbiddenGroup: placeForbiddenOnlyGroup,
      escalationLevel, nightContext,
    };
  }

  // 隣接禁止対象者が優先候補（固定席・要サポートの指定席）を持っていたのに
  // 使えなかった場合のログと、優先候補どおりに配置できた場合の座席9番メッセージ。
  // 貪欲（assignSeats）と全探索（buildFullResult）の両方から使う共通処理。
  function notePreferredSeatOutcome(base, name, seatKey, logs) {
    const preferred = base.preferredSeatsOf.get(name);
    if (!preferred) return;
    const labelMap = base.preferredLabelOf.get(name) || new Map();
    if (labelMap.has(seatKey)) {
      const seat = SEATS.find(s => s.key === seatKey);
      noteSeat9IfUsed(seat, name, labelMap.get(seatKey), logs);
    } else {
      const labels = [...new Set([...labelMap.values()])].join('・');
      logs.push({
        level: 'warn',
        message: `${name}さんは${labels}で指定された座席に配置できなかったため、隣接禁止の条件を優先して別の座席に配置しました。`,
      });
    }
  }

  // ---- 5. その他スタッフ（出勤時刻が早い順）。assignSeats / assignSeatsExhaustive共通 ----
  // deterministic=true（ver0.4.8で追加）のときは座席探索をランダムにせず座席番号順で行う。
  // 全探索backtrackで、隣接禁止対象者側の案を「次案を表示」で切り替えても
  // その他スタッフが無関係に動き回らないようにするための決定的モード。
  // 省略時はfalse（従来どおりランダム＝通常のassignSeatsの挙動）。
  function placeOthers(people, placedNames, state, forbiddenSeatSet, forbiddenPairSet, overflow, logs, nightContext, deterministic) {
    const others = people.filter(p => !placedNames.has(p.pkey));
    others.sort(byStartTimeThenLaterRowFirst);
    for (const person of others) {
      placeOrOverflow(person, state, forbiddenSeatSet, forbiddenPairSet, overflow, placedNames, logs, true, nightContext, deterministic);
    }
  }

  /**
   * 貪欲法（+MRVによる並び替え）による通常の座席割り当て。詳細はbuildBaseAssignmentと
   * 各ステップのコメントを参照。全探索（assignSeatsWithEscalation）が最終段階まで
   * 繰り上げても解けなかった・時間切れだった場合の最終フォールバックとして使う。
   * ver0.4.13から、呼び出し側（ui.js）はこの最終フォールバック時にoptions.adjacentEscalationLevel
   * にADJACENT_ESCALATION_MAX_LEVEL（段階2＝教官・OJTの直後に隣接禁止）を渡し、
   * 全探索で最後に試した優先順位のまま貪欲法で配置する。省略時は既定の段階0
   * （通常の優先順位）で配置する。
   * 戻り値: { state, overflow, logs }
   *   state: { "行-列": [人 | null, 人 | null] }
   *   overflow: 配置しきれなかった人の配列
   *   logs: [{ level:'info'|'warn'|'error', message, showDialog? }]
   */
  function assignSeats(shiftRows, rookieRows, secretRows, options) {
    const base = buildBaseAssignment(shiftRows, rookieRows, secretRows, options);
    const { state, overflow, logs, placedNames, people, forbiddenSeatSet, forbiddenPairSet, nightContext } = base;
    let remaining = base.adjacencyPeople;

    // ---- 4. 隣接禁止対象者 ----
    // 「最も制約がきつい人（＝今この時点で座れる座席が最も少ない人）」から順に配置する
    // （MRV = Minimum Remaining Values の考え方）。1人置くたびに他の人の"座れる座席数"は
    // 変わり得るため、最初に1回だけソートするのではなく、置くたびに数え直す。
    // 座れる座席数が同じ場合は、従来どおり出勤時刻が早い順を使う。
    // 優先候補（固定席・要サポートの指定席）を持つ人は、まず指定席（入力順）を試し、
    // 使えなければ通常の空席探索で配置する。

    // ---- 事前の矛盾検知（動的な範囲）----
    // ここまでの配置が確定した状態(state)で、この時点で既に座れる座席がゼロの人が
    // いないかを、実際に配置を試みる前に洗い出す
    // （禁止席・隣接禁止の条件と、既に確定している他の方の座席の組み合わせによる手詰まり）。
    for (const person of remaining) {
      if (countValidSeats(person, state, forbiddenSeatSet, forbiddenPairSet) !== 0) continue;
      // 席そのものが足りないだけの場合は secret.csv を疑わせない。〈ver0.5.8〉
      if (seatsAvailableIgnoringRules(person, state) === 0) continue;
      logs.push({
        level: 'violation', showDialog: true,
        message: `${person.name}さんは、この時点で座れる座席がありません（禁止席・隣接禁止の条件と、既に確定している他の方の座席の組み合わせにより配置不可能です）。secret.csvの条件を確認してください。`,
      });
    }

    while (remaining.length > 0) {
      let best = null;
      let bestCount = Infinity;
      for (const person of remaining) {
        const cnt = countValidSeats(person, state, forbiddenSeatSet, forbiddenPairSet);
        if (best === null || cnt < bestCount
          || (cnt === bestCount && byStartTimeThenLaterRowFirst(person, best) < 0)) {
          best = person;
          bestCount = cnt;
        }
      }
      remaining = remaining.filter(p => p !== best);
      const preferred = base.preferredSeatsOf.get(best.name);
      const preferredSeat = preferred
        ? findSeatInGivenOrder(preferred, best, state, forbiddenSeatSet, forbiddenPairSet)
        : null;
      if (preferredSeat) {
        seatPerson(state, preferredSeat.key, best);
        placedNames.add(best.pkey);
        notePreferredSeatOutcome(base, best.name, preferredSeat.key, logs);
      } else {
        placeOrOverflow(best, state, forbiddenSeatSet, forbiddenPairSet, overflow, placedNames, logs, false, nightContext);
        // 指定席が使えず通常探索で座れた場合のみ、その旨を知らせる
        // （通常探索でも座れず「あふれ」た場合はplaceOrOverflow側のエラーで足りる）
        if (preferred && !overflow.includes(best)) {
          notePreferredSeatOutcome(base, best.name, null, logs);
        }
      }
    }

    // ---- 4.5 禁止席だけの人、および繰り上げで後回しになったステップ ----
    base.runPostSteps({ state, overflow, logs, placedNames }, false);

    // ---- 5. その他スタッフ ----
    placeOthers(people, placedNames, state, forbiddenSeatSet, forbiddenPairSet, overflow, logs, nightContext);

    return { state, overflow, logs };
  }

  // ============================================================
  // 全探索backtrack（全パターン検索）
  // 隣接禁止・禁止席対象者の配置を担当する。普段の貪欲+MRV（assignSeats）
  // とはロジックの性格が異なる（実際にすべての組み合わせを尽くす）ため、可読性のために
  // ここでセクションを分けている（旧ver0.4.8まではalgorithmExhaustive.jsという別ファイルに
  // 分離していたが、ver0.4.9でこのファイルへ統合した。読み込むファイルが1つで済むほか、
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
  // 「次案を表示」ボタンで同じ内容の案が重複して出てこないよう、正規化した文字列で
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
  //   画面表示上は「同時刻入替」と呼んでいる。
  // ・variance: 各座席の埋まり方（0/1/2人）の分散。小さいほど席の偏りが少ない。
  // この関数が返すのはこの2つだが、実際の候補の並べ替えでは、呼び出し側
  // （buildFullResult）が preferredMiss（指定席どおりに配置できなかった人数）を
  // 加えた3つを、①preferredMiss → ②boundaryMatches → ③variance の辞書式で比較する。
  // （必要に応じて指標を追加・調整できるよう、内訳をそのまま返す。）
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
   * 全探索backtrack: 隣接禁止対象者について、真の全探索（枝刈り付きbacktrack）を行う。
   * assignSeats（貪欲+MRV+乱数リトライ）では「たまたま見つからなかっただけ」の
   * 可能性が残るのに対し、こちらは実際にすべての座席割り当てを尽くすため、
   * 「本当に解が存在するか」を（タイムアウトしない限り）証明つきで判定できる。
   * ver0.4.10までは禁止席だけの人も一括で探索していたが、ver0.4.11からは
   * この関数の探索対象を隣接禁止対象者のみに絞り、禁止席だけの人は要サポートの後に
   * 別枠で配置する（buildBaseAssignmentのplaceForbiddenOnlyGroup参照）。
   * その別枠でも ver0.4.12 から全探索backtrackを行うため、禁止席だけの人も
   * 貪欲ではなく全探索で配置される（違いは、こちらが複数解を集めて採点・比較するのに対し、
   * 向こうは実行可能解を1つ見つけた時点で確定し採点しない点）。
   *
   * 優先フラグと「隣接禁止ステップより前の各ステップ」は buildBaseAssignment で
   * 通常どおり確定させ（どのステップが前に来るかは options.adjacentEscalationLevel
   * による。この部分はassignSeatsと完全に同じロジック。ここを揺らがせると探索対象が
   * 際限なく広がってしまうため、意図的に固定値として扱う）、
   * その後に残った隣接禁止対象者だけをbacktrack探索の対象にする。
   * 対象者が固定席・要サポートの指定席を持っている場合（繰り上げでそれらのステップが
   * 後回しになった場合に発生）は、その指定席を候補の先頭で試し、解の採点でも
   * 「指定席どおりに配置できた解」を優先する。
   *
   * options:
   *   adjacentEscalationLevel: 隣接禁止ステップの繰り上げ段階
   *                 （0〜ADJACENT_ESCALATION_MAX_LEVEL＝0〜2。省略時0）
   *   maxSolutions: 最終的に返す上位解の件数（既定20。「次案を表示」ボタンで一巡できる件数の目安）。
   *                 実運用ではui.jsが EXHAUSTIVE_MAX_SOLUTIONS=99 を渡すため、既定値は使われない。
   *   poolCap:      採点前に内部的に集める解の件数の上限（既定100。多すぎると採点コストが増えるため上限を設ける）
   *                 ver0.4.17から、呼び出し側（ui.js）は poolCap = maxSolutions + 1 を渡す。
   *                 こうすると「maxSolutions件を表示しきってもなお解が残っている」ことを
   *                 hitPoolCap で正確に判定でき、メッセージの「○通り以上」を厳密に出せる。
   *   timeBudgetMs: 探索の制限時間（既定5000ms=5秒。隣接禁止対象者は通常少人数のはずで、
   *                 実運用では一瞬で解が出る想定）。これを超えたら打ち切り、
   *                 その時点で見つかっている解・部分解で結果を返す（timedOut:trueで示す）。
   *                 実運用ではui.jsが EXHAUSTIVE_TIME_BUDGET_MS を渡す（現在5000ms）。
   *
   * 戻り値: {
   *   feasible: boolean,        対象者全員を配置できる解が1つ以上見つかったか。
   *                             隣接禁止対象者がbacktrackより前のステップで既に
   *                             「あふれ」に落ちていた場合（優先フラグ等での配置失敗）も
   *                             falseになる（preStepOverflowNames参照）
   *   timedOut: boolean,        制限時間で打ち切ったか（true の場合、feasible:false でも
   *                             「本当に解なし」と証明できたわけではない点に注意）
   *   nodesExplored: number,    探索した分岐の数（目安）
   *   elapsedMs: number,        全探索にかかった実時間（ミリ秒）
   *   totalSolutionsFound: number,  poolCap内で実際に見つかった（重複排除後の）解の総数
   *   hitPoolCap: boolean,          poolCapに到達して探索を打ち切ったか（＝まだ他にも解がある）。
   *                                 falseなら探索し尽くしたか、時間切れ（timedOut参照）のどちらか。
   *   escalationLevel: number,  この探索で使った繰り上げ段階（0〜2）
   *   preStepOverflowNames: [string],  backtrackより前のステップで「あふれ」に落ちた
   *                             隣接禁止対象者の氏名（通常は空。空でない場合feasible:false）
   *   solutions: [{
   *     state, overflow, logs, score,               完成した座席表（「その他」を含む）
   *     stateBeforeOthers, overflowBeforeOthers,     「その他」を配置する直前の状態
   *     logsBeforeOthers, placedNamesBeforeOthers,   （禁止席だけの人は配置済み）
   *     stateBeforeForbiddenAndOthers,                「禁止席だけの人・その他」を
   *     overflowBeforeForbiddenAndOthers,             配置する直前の状態（ver0.4.15で追加。
   *     logsBeforeForbiddenAndOthers,                 reshuffleForbiddenAndOthers用に保持）
   *     placedNamesBeforeForbiddenAndOthers,
   *   }],  スコア順（良い順）の上位solutions。採点は
   *        ①指定席（固定席・要サポート）どおりに配置できなかった対象者の人数（少ないほど良い）
   *        ②境界時刻ぴったりの同席数 ③座席の埋まり方の分散、の順で比較する。
   *        「その他」および繰り上げで後回しになったステップ・禁止席だけの人は、
   *        ランダムではなく決定的な順序で配置している（隣接禁止対象者側の案を
   *        切り替えたときに、無関係な人が動いて見えるのを防ぐため）。
   *   bestPartial: null | { placedCount, unplacedNames },
   *     feasible:false のとき、最も惜しかった（最も多く配置できた）部分解の情報。
   *     unplacedNamesがその組み合わせで配置できなかった人（探索全体で他の組み合わせなら
   *     配置できた可能性はあるため、あくまで参考情報）
   *   context: { people, forbiddenSeatSet, forbiddenPairSet, nightContext, placeForbiddenGroup },
   *     reshuffleForbiddenAndOthers(solution, context) を呼ぶ際にそのまま渡すための共通情報。
   * }
   */
  function assignSeatsExhaustive(shiftRows, rookieRows, secretRows, options) {
    const opts = options || {};
    // 既定値は、呼び出し側（ui.js）が値を渡さなかった場合のみ使われる。実運用では
    // ui.js が EXHAUSTIVE_MAX_SOLUTIONS / EXHAUSTIVE_POOL_CAP / EXHAUSTIVE_TIME_BUDGET_MS を
    // 常に明示的に渡すため、ここの既定値は実質テスト・直接呼び出し用。
    // 「既定値と実運用値が食い違っている」状態を避けるため、ver0.4.17の実運用値に揃えてある。
    const maxSolutions = opts.maxSolutions || 20;
    const poolCap = opts.poolCap || 100;
    const timeBudgetMs = opts.timeBudgetMs || 5000;

    const base = buildBaseAssignment(shiftRows, rookieRows, secretRows, options);
    const {
      state: baseState, placedNames: basePlacedNames, people, byName, byKey,
      forbiddenSeatSet, forbiddenPairSet, adjacencyPeople, nightContext,
      overflow: baseOverflow, logs: baseLogs, escalationLevel,
    } = base;

    // backtrackより前のステップ（優先フラグや、繰り上げ段階に応じて前に来た各ステップ）で
    // 「あふれ」に落ちてしまった隣接禁止対象者。この人たちの配置は既に確定して
    // しまっているためbacktrackでは救えない＝この段階では隣接禁止の条件を満たせて
    // いないものとして扱う（呼び出し側で次の段階への繰り上げ判断に使う）。
    const preStepOverflowNames = baseOverflow
      .filter(p => p.hasAdjacentRule)
      .map(p => p.name);

    // 優先候補（固定席・要サポートの指定席）のseatKey集合（探索時のcanPlace判定用。
    // 明示指定された座席のみ座席9番も許可するため）
    const preferredKeySetOf = new Map(); // name -> Set(seatKey)
    for (const [name, seats] of base.preferredSeatsOf.entries()) {
      preferredKeySetOf.set(name, new Set(seats.map(s => s.key)));
    }

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

    // この人にとってこの座席が配置可能か（優先候補として明示指定された座席のみ
    // 座席9番を許可する）
    function canPlaceForSearch(person, seat) {
      const prefKeys = preferredKeySetOf.get(person.name);
      const allowSeat9 = !!(prefKeys && prefKeys.has(seat.key));
      return canPlace(person, seat, searchState, forbiddenSeatSet, forbiddenPairSet, allowSeat9);
    }

    // 候補座席の並び順: 優先候補（固定席・要サポートの指定席。入力順）を先頭に、
    // 残りはseatsForSearchの順のまま続ける。backtrackは先頭の候補から試すため、
    // 指定席が使える解ほど先に見つかりやすくなる（最終的な優先は採点側でも担保する）。
    function orderCandidates(person, cands) {
      const preferred = base.preferredSeatsOf.get(person.name);
      if (!preferred) return cands;
      const candSet = new Set(cands);
      const first = preferred.filter(s => candSet.has(s));
      if (first.length === 0) return cands;
      const firstSet = new Set(first);
      return [...first, ...cands.filter(s => !firstSet.has(s))];
    }

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
        const cands = seatsForSearch.filter(seat => canPlaceForSearch(remaining[i], seat));
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

      for (const seat of orderCandidates(person, bestCandidates)) {
        seatPerson(searchState, seat.key, person);
        assignedMap.set(person.pkey, seat.key);

        search(rest, assignedMap);

        assignedMap.delete(person.pkey);
        const slots = searchState[seat.key];
        const idx = slots.indexOf(person);
        if (idx !== -1) slots[idx] = null;

        if (timedOut || foundAssignments.length >= poolCap) return;
      }
    }

    // backtrackより前のステップで「あふれ」た隣接禁止対象者がいる場合、その人は
    // もう救えないため探索自体を行わない（この段階は失敗として扱い、呼び出し側で
    // 次の段階へ繰り上げてもらう）
    if (preStepOverflowNames.length === 0) {
      search(adjacencyPeople, new Map());
    } else {
      bestPartial = { placedCount: 0, unplacedNames: preStepOverflowNames.slice() };
    }

    const feasible = foundAssignments.length > 0 && preStepOverflowNames.length === 0;

    function buildFullResult(assignedMap) {
      // 隣接禁止対象者(adjacencyPeople)まで確定させたら、繰り上げで後回しになった
      // ステップ（要サポート等）を先に配置し、その状態を「禁止席だけの人・
      // その他」を配置する直前のスナップショットとして保持しておく（ver0.4.15）。
      // これにより、あとから reshuffleForbiddenAndOthers() で隣接禁止対象者・
      // 固定席・要サポート・教官OJT・新人固定席側の配置はそのままに、
      // 禁止席だけの人とその他だけを配置し直せる（シャッフルボタン用）。
      const ctx = {
        state: deepCloneState(baseState),
        overflow: baseOverflow.slice(),
        logs: baseLogs.slice(),
        placedNames: new Set(basePlacedNames),
      };
      // 指定席（固定席・要サポート）どおりに配置できなかった対象者の人数（採点用）
      let preferredMiss = 0;
      // assignedMapはpkey（氏名|開始時刻）で持つ。〈ver0.4.18〉
      // 一方、固定席・要サポートの指定（secret.csv）は氏名で紐づいたままのため、
      // preferredSeatsOf / preferredKeySetOf の参照には人の氏名を使う。
      for (const [pkey, seatKey] of assignedMap.entries()) {
        const person = byKey.get(pkey);
        if (!person) continue;
        seatPerson(ctx.state, seatKey, person);
        ctx.placedNames.add(pkey);
        if (base.preferredSeatsOf.has(person.name)) {
          const prefKeys = preferredKeySetOf.get(person.name);
          if (!prefKeys.has(seatKey)) preferredMiss++;
        }
        notePreferredSeatOutcome(base, person.name, seatKey, ctx.logs);
      }

      // 繰り上げで後回しになったステップ（要サポート等）を配置する
      // （禁止席だけの人・その他はまだ配置しない）
      base.runPostponedSteps(ctx);

      const stateBeforeForbiddenAndOthers = deepCloneState(ctx.state);
      const placedNamesBeforeForbiddenAndOthers = new Set(ctx.placedNames);
      const overflowBeforeForbiddenAndOthers = ctx.overflow.slice();
      const logsBeforeForbiddenAndOthers = ctx.logs.slice();

      // 禁止席だけの人もforbiddenMode='exhaustive'で全探索する（ver0.4.12）。
      // deterministic=true・座席番号順（既定のSEATS順）: 案を切り替えたときに
      // 無関係な人が動いて見えないよう、常に同じ組み合わせを選ぶ。
      // clockはこの段階の主探索（隣接禁止対象者のbacktrack）と同じ{startTime, timeBudgetMs}を
      // 共有し、この段階全体（隣接禁止探索＋各解ごとの禁止席探索の合計）で
      // timeBudgetMsを超えないようにする。
      base.placeForbiddenGroup(ctx, true, 'exhaustive', { startTime, timeBudgetMs });

      const stateBeforeOthers = deepCloneState(ctx.state);
      const placedNamesBeforeOthers = new Set(ctx.placedNames);
      const overflowBeforeOthers = ctx.overflow.slice();
      const logsBeforeOthers = ctx.logs.slice();

      // 「その他」は既定では座席番号順の決定的な配置にする（ランダムにしない）。
      // ランダムな配置がほしい場合は reshuffleForbiddenAndOthers() を別途呼ぶ
      // （シャッフルボタン用）。
      placeOthers(people, ctx.placedNames, ctx.state, forbiddenSeatSet, forbiddenPairSet, ctx.overflow, ctx.logs, nightContext, true /* deterministic */);

      return {
        state: ctx.state, overflow: ctx.overflow, logs: ctx.logs,
        score: { preferredMiss, ...scoreSolution(ctx.state) },
        stateBeforeOthers, overflowBeforeOthers, logsBeforeOthers, placedNamesBeforeOthers,
        stateBeforeForbiddenAndOthers, overflowBeforeForbiddenAndOthers,
        logsBeforeForbiddenAndOthers, placedNamesBeforeForbiddenAndOthers,
      };
    }

    const fullResults = foundAssignments.map(buildFullResult);
    fullResults.sort((a, b) => {
      if (a.score.preferredMiss !== b.score.preferredMiss) return a.score.preferredMiss - b.score.preferredMiss;
      if (a.score.boundaryMatches !== b.score.boundaryMatches) return a.score.boundaryMatches - b.score.boundaryMatches;
      return a.score.variance - b.score.variance;
    });

    return {
      feasible,
      timedOut,
      nodesExplored,
      elapsedMs: Date.now() - startTime,
      totalSolutionsFound: foundAssignments.length,
      hitPoolCap: foundAssignments.length >= poolCap,
      escalationLevel,
      preStepOverflowNames,
      solutions: fullResults.slice(0, maxSolutions),
      bestPartial: feasible ? null : bestPartial,
      // reshuffleForbiddenAndOthers(solution, context) を呼ぶ際にそのまま渡す共通情報。
      // placeForbiddenGroupはbuildBaseAssignmentのクロージャ（禁止席だけの人の
      // 全探索＋貪欲フォールバックのロジック一式）をそのまま再利用するために含めている。
      context: { people, forbiddenSeatSet, forbiddenPairSet, nightContext, placeForbiddenGroup: base.placeForbiddenGroup },
    };
  }

  /**
   * 隣接禁止の繰り上げ再探索つき全探索（ver0.4.11で追加）。
   * まず段階0（通常の優先順位）で assignSeatsExhaustive を実行し、隣接禁止対象者
   * 全員を配置できる解が見つからなかった場合（解なしと証明された場合・制限時間で
   * 打ち切られた場合の両方）は、隣接禁止ステップを1段階前へ繰り上げて再探索する。
   * これを段階2（教官・OJTの直後）まで繰り返す。優先フラグ・新人固定席・教官・OJTは常に先のまま動かさない。
   *
   * options は assignSeatsExhaustive と同じ（adjacentEscalationLevelは内部で
   * 上書きするため指定不要。timeBudgetMsは「1段階あたり」の制限時間になる点に注意）。
   *
   * 戻り値: 成功した段階の assignSeatsExhaustive の戻り値に以下を加えたもの:
   *   escalationLevel: 成功した段階（0〜2）。全段階失敗ならnull
   *   attempts: [{ level, feasible, timedOut, preStepOverflowNames, bestPartial, elapsedMs }]
   *     各段階の試行結果（メッセージ表示用）。
   * 全段階失敗の場合は、最後の段階（段階2）の戻り値に escalationLevel:null と
   * attempts を付けたものを返す（呼び出し側で貪欲法にフォールバックする）。
   */
  // 1段階ぶんの探索。同期版・非同期版から共通で呼ぶ。
  function runEscalationLevel(shiftRows, rookieRows, secretRows, opts, level) {
    const result = assignSeatsExhaustive(shiftRows, rookieRows, secretRows,
      { ...opts, adjacentEscalationLevel: level });
    return {
      result,
      attempt: {
        level,
        feasible: result.feasible,
        timedOut: result.timedOut,
        preStepOverflowNames: result.preStepOverflowNames,
        bestPartial: result.bestPartial,
        elapsedMs: result.elapsedMs,
      },
    };
  }

  function assignSeatsWithEscalation(shiftRows, rookieRows, secretRows, options) {
    const opts = options || {};
    const attempts = [];
    let last = null;
    for (let level = 0; level <= ADJACENT_ESCALATION_MAX_LEVEL; level++) {
      const { result, attempt } = runEscalationLevel(shiftRows, rookieRows, secretRows, opts, level);
      attempts.push(attempt);
      if (result.feasible && result.solutions.length > 0) {
        return { ...result, escalationLevel: level, attempts };
      }
      last = result;
    }
    return { ...last, escalationLevel: null, attempts };
  }

  /**
   * assignSeatsWithEscalation の非同期版。〈ver0.5.8で追加〉
   * 1段階ごとに onLevel(level, maxLevel) を await するため、呼び出し側は
   * そこで画面を描き直せる（「計算中…」の表示を出す）。
   * 解が見つからない日は1段階5秒×3段階＝最大15秒かかり、その間ブラウザが
   * 固まったままだと利用者は「壊れた」と判断してしまうため。
   * 探索そのものは同期のままなので、固まる時間は最大でも1段階ぶん（5秒）になる。
   * 結果は同期版と完全に同じ（同じ入力なら同じ探索を同じ順で行う）。
   */
  async function assignSeatsWithEscalationAsync(shiftRows, rookieRows, secretRows, options, onLevel) {
    const opts = options || {};
    const attempts = [];
    let last = null;
    for (let level = 0; level <= ADJACENT_ESCALATION_MAX_LEVEL; level++) {
      if (onLevel) await onLevel(level, ADJACENT_ESCALATION_MAX_LEVEL);
      const { result, attempt } = runEscalationLevel(shiftRows, rookieRows, secretRows, opts, level);
      attempts.push(attempt);
      if (result.feasible && result.solutions.length > 0) {
        return { ...result, escalationLevel: level, attempts };
      }
      last = result;
    }
    return { ...last, escalationLevel: null, attempts };
  }

  /**
   * 隣接禁止対象者・固定席・要サポート・教官OJT・新人固定席側の座席はそのままに、
   * 「禁止席だけの人」と「その他」スタッフをまとめて配置し直す
   * （シャッフルボタン用。ver0.4.15。旧reshuffleOthersを改称・拡張）。
   * 禁止席だけの人は、座席の探索順をランダム化した全探索backtrackで
   * 別の有効な組み合わせを探す（複数の組み合わせが存在すればランダムに切り替わる。
   * 1通りしかない場合は毎回同じ結果になる）。制限時間内に見つからなかった場合は
   * 貪欲法にフォールバックする（自動配置時と同じロジックをcontext.placeForbiddenGroup
   * 経由で再利用しているため、フォールバック時のログ文言も同じになる）。
   * solution: assignSeatsExhaustive の戻り値 solutions[i]
   *   （stateBeforeForbiddenAndOthers等を含むもの）
   * context:  assignSeatsExhaustive の戻り値の context をそのまま渡す
   * 戻り値: { state, overflow, logs, score }（buildFullResultの戻り値と同形。
   *          stateBeforeForbiddenAndOthers等は変わらないため呼び出し側で使い回せる）
   */
  function reshuffleForbiddenAndOthers(solution, context) {
    const ctx = {
      state: deepCloneState(solution.stateBeforeForbiddenAndOthers),
      overflow: solution.overflowBeforeForbiddenAndOthers.slice(),
      logs: solution.logsBeforeForbiddenAndOthers.slice(),
      placedNames: new Set(solution.placedNamesBeforeForbiddenAndOthers),
    };
    // deterministic=false・座席の探索順をシャッフルして全探索することで、有効な
    // 組み合わせが複数あればそのつどランダムに選ばれるようにする。
    context.placeForbiddenGroup(
      ctx, false, 'exhaustive',
      { startTime: Date.now(), timeBudgetMs: 3000 },
      shuffle(SEATS)
    );
    placeOthers(
      context.people, ctx.placedNames, ctx.state,
      context.forbiddenSeatSet, context.forbiddenPairSet,
      ctx.overflow, ctx.logs, context.nightContext,
      false /* deterministic=false → ランダムに配置し直す */
    );
    return { state: ctx.state, overflow: ctx.overflow, logs: ctx.logs, score: scoreSolution(ctx.state) };
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
  // 夜勤の役席・GLの配置（ver0.4.2）
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
      // 入った場合は、指定どおりの結果のためメッセージは出さない（ver0.4.5）。
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
    // 隣接禁止のペア単位の情報と、記号の整形（ver0.5.4。バッジの出し分けに使う）
    buildAdjacentPairs, formatAdjacentLabel,
    seatByNumber, numberOfKey, numberOfSeat,
    assignLeaderAreas, assignNightLeaders,
    buildOjtIndexes, buildRookieIndexes,
    countValidSeats, detectStaticContradictions,
    // CSV入力チェックのB-7（座れる席がゼロ）判定用〈ver0.5.7で追加〉
    remainingSeatKeysAfterForbidden,
    buildBaseAssignment,
    // 以下は内部関数だが、全探索backtrackやテストから使うために公開している
    seatPerson, slotOccupants, shuffle, placeOthers,
    SEATS_IN_NUMBER_ORDER, findSeat, findSeatAmongCandidates,
    // 全探索backtrack（全パターン検索。ver0.4.9でこのファイルに統合）
    assignSeatsExhaustive, reshuffleForbiddenAndOthers, scoreSolution,
    // 隣接禁止の繰り上げ再探索（ver0.4.11で追加）
    assignSeatsWithEscalation, assignSeatsWithEscalationAsync, ADJACENT_ESCALATION_MAX_LEVEL,
  };
})();
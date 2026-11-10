import { NextRequest, NextResponse } from "next/server";
import { getAdminDb } from "@/lib/firebase-admin";
import { verifySession } from "@/lib/dal";
import { unauthorized } from "@/lib/server-session";
import { enforceRateLimit, RATE } from "@/lib/rate-limit";
import { assertSameOrigin } from "@/lib/csrf";
import { ROLE_LABELS, UserRole } from "@/types/users";
import { serverErrorMessage } from "@/lib/api-error";
import { cachedRead, invalidateReadCache } from "@/lib/read-cache";
import { readJsonBody } from "@/lib/http-body";

const COLLECTION = "examLeaderboard";
const TOP_N = 100;
const MAX_SCORE = 100;
/** 前 100 名榜單的讀取快取（鐵律 6）：純展示，送出成績後立即失效 */
const TOP_TTL_MS = 15_000;
const TOP_CACHE_KEY = `leaderboard:top:${COLLECTION}`;

export interface LeaderboardEntry {
  uid: string;
  name: string;
  role: UserRole;
  score: number;
  updatedAt: number;
}

function displayNameOf(session: { account: string; displayName?: string }): string {
  return session.displayName || session.account || "玩家";
}

function formatRecordDate(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return "";
  const d = new Date(ms);
  return `${d.getFullYear()}年${d.getMonth() + 1}月${d.getDate()}日`;
}

export async function GET(request: NextRequest) {
  try {
    const limited = enforceRateLimit(
      request,
      "leaderboard-get",
      RATE.LEADERBOARD_GET.limit,
      RATE.LEADERBOARD_GET.windowMs
    );
    if (limited) return limited;

    const col = getAdminDb().collection(COLLECTION);
    // 前100名＝所有人共用的展示資料：15 秒內的重複瀏覽不重讀（「我的名次」不快取，逐使用者精準查）
    const topSnap = await cachedRead(TOP_CACHE_KEY, TOP_TTL_MS, () =>
      col.orderBy("score", "desc").limit(TOP_N).get()
    );

    const top = topSnap.docs.map((d, index) => {
      const data = d.data() as LeaderboardEntry;
      return {
        rank: index + 1,
        name: data.name,
        role: data.role,
        roleLabel: ROLE_LABELS[data.role] ?? data.role,
        score: Number(data.score) || 0,
        recordDate: formatRecordDate(Number(data.updatedAt) || 0),
      };
    });

    const session = await verifySession();
    let my: {
      name: string;
      role: UserRole;
      roleLabel: string;
      score: number;
      rank: number | null;
      recordDate: string;
    } | null = null;

    if (session) {
      const mineSnap = await col.where("uid", "==", session.uid).limit(1).get();
      if (!mineSnap.empty) {
        const data = mineSnap.docs[0].data() as LeaderboardEntry;
        const rankIndex = topSnap.docs.findIndex(
          (d) => (d.data() as LeaderboardEntry).uid === session.uid
        );
        my = {
          name: data.name,
          role: data.role,
          roleLabel: ROLE_LABELS[data.role] ?? data.role,
          score: Number(data.score) || 0,
          rank: rankIndex >= 0 ? rankIndex + 1 : null,
          recordDate: formatRecordDate(Number(data.updatedAt) || 0),
        };
      }
    }

    return NextResponse.json({ success: true, top, my });
  } catch (error) {
    return NextResponse.json(
      { success: false, message: serverErrorMessage(error, "系統錯誤，請稍後再試") },
      { status: 500 }
    );
  }
}

export async function POST(request: NextRequest) {
  const originDenied = assertSameOrigin(request);
  if (originDenied) return originDenied;

  const session = await verifySession();
  if (!session) return unauthorized();

  const limited = enforceRateLimit(
    request,
    "leaderboard-post",
    RATE.LEADERBOARD_POST.limit,
    RATE.LEADERBOARD_POST.windowMs,
    session.uid
  );
  if (limited) return limited;

  const parsed = await readJsonBody<Record<string, unknown>>(request);
  if (!parsed.ok) return parsed.response;
  const body = parsed.data;
  const raw = body?.score;
  if (
    typeof raw !== "number" ||
    !Number.isFinite(raw) ||
    raw < 0 ||
    raw > MAX_SCORE
  ) {
    return NextResponse.json({ success: false, message: "達成率無效" }, { status: 400 });
  }
  const newScore = Math.round(raw);

  try {
    const col = getAdminDb().collection(COLLECTION);
    const name = displayNameOf(session);

    const mineSnap = await col.where("uid", "==", session.uid).limit(1).get();
    const mineDoc = mineSnap.docs[0] ?? null;
    const currentScore = mineDoc ? Number(mineDoc.data().score) || 0 : 0;

    if (mineDoc && newScore <= currentScore) {
      return NextResponse.json({
        success: true,
        score: currentScore,
        improved: false,
        ranked: true,
      });
    }

    const topSnap = await col.orderBy("score", "desc").limit(TOP_N).get();
    const cutoff =
      topSnap.size >= TOP_N ? Number(topSnap.docs[TOP_N - 1].data().score) || 0 : 0;

    if (!mineDoc && topSnap.size >= TOP_N && newScore <= cutoff) {
      return NextResponse.json({
        success: true,
        score: newScore,
        improved: false,
        ranked: false,
      });
    }

    const payload = {
      uid: session.uid,
      name,
      role: session.role,
      score: newScore,
      updatedAt: Date.now(),
    };

    if (mineDoc) {
      await mineDoc.ref.update(payload);
    } else {
      await col.add(payload);
    }
    // 榜單已變更：立刻失效，下次瀏覽重新讀取
    invalidateReadCache("leaderboard:top:");

    const excessSnap = await col
      .orderBy("score", "desc")
      .offset(TOP_N)
      .select("score")
      .get();
    if (!excessSnap.empty) {
      await Promise.all(excessSnap.docs.map((d) => d.ref.delete()));
    }

    // 名次直接用「寫入前的前100」＋本次分數算：只有自己的分數變動，
    // 不必再讀一次榜單（省 TOP_N 次讀取）
    const others = topSnap.docs
      .map((d) => d.data() as LeaderboardEntry)
      .filter((d) => d.uid !== session.uid);
    const higher = others.filter((d) => (Number(d.score) || 0) > newScore).length;
    const ranked = others.length < TOP_N || higher < TOP_N;
    const rank = ranked ? higher + 1 : null;

    return NextResponse.json({
      success: true,
      score: newScore,
      improved: true,
      ranked,
      rank,
    });
  } catch (error) {
    return NextResponse.json(
      { success: false, message: serverErrorMessage(error, "系統錯誤，請稍後再試") },
      { status: 500 }
    );
  }
}

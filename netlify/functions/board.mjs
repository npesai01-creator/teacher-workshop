// 수업자료 이야기방 - 응답 저장 서버 (Netlify Functions + Netlify Blobs)
// 모든 응답은 Netlify Blobs의 "workshop" 저장소에 board 하나로 보관돼요.
import { getStore } from "@netlify/blobs";

const KEY = "board";
// 진행자 비밀번호: Netlify 환경 변수 ADMIN_PIN 으로 바꿀 수 있어요. (없으면 1234)
const ADMIN_PIN = () => process.env.ADMIN_PIN || "1234";

const CHOICES = ["often", "some", "never"];
const KINDS = ["PPT·슬라이드", "학습지·활동지", "영상", "퀴즈·게임", "디지털 도구", "교구·실물", "평가지", "기타"];
const CATS = ["time", "design", "tool", "find", "device", "level", "share", "etc"];
const MAX_PEOPLE = 500;

const empty = () => ({ q1: {}, q2: {}, likes: {} });
const json = (data, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });
const text = (s, n) => (typeof s === "string" ? s.trim().slice(0, n) : "");
const okKey = (k) => typeof k === "string" && /^[A-Za-z0-9_-]{4,40}$/.test(k);
const newId = () => Math.random().toString(36).slice(2, 10);
const people = (d) => new Set([...Object.keys(d.q1), ...Object.keys(d.q2), ...Object.keys(d.likes)]).size;

// 요청 하나를 board에 반영해요. 문제가 있으면 오류 문구를 돌려줘요.
function apply(d, b) {
  const key = b.key;
  const isNew = !d.q1[key] && !d.q2[key] && !d.likes[key];
  if (["q1", "add", "like"].includes(b.op) && isNew && people(d) >= MAX_PEOPLE) return "full";

  switch (b.op) {
    case "q1": {
      if (!CHOICES.includes(b.choice)) return "choice";
      const kinds = Array.isArray(b.kinds) ? b.kinds.filter((k) => KINDS.includes(k)).slice(0, KINDS.length) : [];
      d.q1[key] = {
        choice: b.choice,
        kinds: b.choice === "never" ? [] : kinds,
        note: text(b.note, 150),
        hard: text(b.hard, 200),
        name: text(b.name, 12) || "익명 선생님",
        at: Date.now(),
      };
      return null;
    }
    case "add": {
      const t = text(b.text, 200);
      if (t.length < 2 || !CATS.includes(b.cat)) return "card";
      const mine = d.q2[key] || { name: "", items: [] };
      if (mine.items.length >= 15) return "limit";
      mine.name = text(b.name, 12) || "익명 선생님";
      mine.items.push({ id: newId(), cat: b.cat, text: t, at: Date.now() });
      d.q2[key] = mine;
      return null;
    }
    case "del": {
      const mine = d.q2[key];
      if (mine) mine.items = mine.items.filter((i) => i.id !== b.id);
      return null;
    }
    case "like": {
      const card = typeof b.card === "string" ? b.card.slice(0, 80) : "";
      const [owner, id] = card.split("|");
      if (owner === key) return "own";
      const exists = d.q2[owner] && d.q2[owner].items.some((i) => i.id === id);
      const cur = new Set((d.likes[key] && d.likes[key].keys) || []);
      if (cur.has(card)) cur.delete(card);
      else if (exists) cur.add(card);
      d.likes[key] = { keys: [...cur].slice(0, 300) };
      return null;
    }
    case "hide": {
      const [owner, id] = String(b.card || "").split("|");
      if (d.q2[owner]) d.q2[owner].items = d.q2[owner].items.filter((i) => i.id !== id);
      return null;
    }
    case "reset": {
      d.q1 = {};
      d.q2 = {};
      d.likes = {};
      return null;
    }
    default:
      return "op";
  }
}

export default async (req) => {
  const store = getStore({ name: "workshop", consistency: "strong" });

  if (req.method === "GET") {
    const d = await store.get(KEY, { type: "json" });
    return json(d || empty());
  }
  if (req.method !== "POST") return json({ error: "method" }, 405);

  let b;
  try {
    b = await req.json();
  } catch {
    return json({ error: "bad request" }, 400);
  }
  if (!b || typeof b !== "object") return json({ error: "bad request" }, 400);

  // 진행자 기능은 비밀번호가 맞아야 해요
  if (["checkpin", "hide", "reset"].includes(b.op)) {
    if (b.pin !== ADMIN_PIN()) return json({ error: "pin" }, 403);
    if (b.op === "checkpin") return json((await store.get(KEY, { type: "json" })) || empty());
  } else if (!okKey(b.key)) {
    return json({ error: "key" }, 400);
  }

  // 여러 명이 동시에 저장해도 응답이 사라지지 않도록, 바뀐 게 있으면 다시 읽고 다시 써요
  for (let i = 0; i < 10; i++) {
    const cur = await store.getWithMetadata(KEY, { type: "json" });
    const d = (cur && cur.data) || empty();
    const err = apply(d, b);
    if (err) return json({ error: err }, err === "full" ? 429 : 400);
    const body = JSON.stringify(d);
    const res = cur
      ? await store.set(KEY, body, { onlyIfMatch: cur.etag })
      : await store.set(KEY, body, { onlyIfNew: true });
    // res가 비어 있으면(조건부 저장을 모르는 옛 버전) 저장된 것으로 봐요
    if (!res || res.modified !== false) return json(d);
    await new Promise((r) => setTimeout(r, 30 + Math.random() * 150));
  }
  return json({ error: "busy" }, 503);
};

export const config = { path: "/api/board" };

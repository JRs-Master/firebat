'use client';

import React, { useEffect, useRef, useState } from 'react';

// ── 공통 재생기 ────────────────────────────────────────────────────────────────────────────────
// 재생·위치·배속·볼륨·전체반복·A-B 구간반복은 어느 표면에서든 같은 물건이라 한 곳에 산다.
// 지금 쓰는 곳 = 채팅 파일카드 · 공유 페이지 · 미디어 미디어 · 노래방 · 토익 LC.
// 표면마다 다른 건 셋뿐: **색**(테마 토큰) · **A-B 를 무엇에 붙이나**(snapTo — 토익은 단어,
// 노래방은 가사 줄) · **그 표면만의 컨트롤**(children).
//
// 생김새는 **브라우저 기본 재생기의 손버릇을 따르되**(손이 이미 아는 모양이라 배울 게 없다)
// 모서리·색은 우리 것이다. 네이티브를 안 쓰는 이유는 모양이 싫어서가 아니라 브라우저마다
// 다르고(사파리엔 배속도 다운로드도 없다) 그 ⋮ 안에 우리 파일(.lrc)을 넣을 수 없어서다.
//
// ⚠️ **막대 안에 "소리"라는 표식(음표 같은)을 넣지 않는다** — 이 재생기를 쓰는 표면은 전부
// 자기가 먼저 그 말을 하고 있다(파일카드의 아이콘 타일 · 노래방의 마이크 · 미디어의 큰 음표).
// 한 번 넣었다가 걷었다: 카드 타일과 나란히 놓이니 같은 말이 두 번이었다(8/19 사용자 지적).
export type TransportTheme = {
  /** 바깥 상자(연습 도구 줄까지 감싼다). 파일카드처럼 카드가 이미 있으면 transparent. */
  surface: string; border: string; radius: string; pad: string;
  /** 재생 막대 자체 — 기본 재생기의 회색 알약. */
  bar: string; barRadius: string; barPad: string;
  accent: string; text: string; muted: string; track: string; pill: string; pillOn: string;
};
export const TRANSPORT_THEMES: Record<string, TransportTheme> = {
  // 기본 = 브라우저 재생기의 손버릇을 따르되 **모서리는 우리 것**(rounded-lg — 카드·상자·입력이
  // 쓰는 반경). 색도 파랑이 아니라 중립 먹색이다: 재생기는 강조 위젯이 아니라 도구고, 화면의
  // 주인공은 가사·스크립트·파일 이름이다.
  plain: {
    surface: 'transparent', border: 'transparent', radius: '0', pad: '0px',
    bar: '#f1f3f4', barRadius: '0.5rem', barPad: '0.25rem 0.5rem',
    accent: '#3c4043', text: '#202124', muted: '#5f6368', track: '#dadce0',
    pill: '#e8eaed', pillOn: '#cbd0d5',
  },
  // 시험지 미색지 — 카드와 같은 종이색이라 재생기가 종이 위에서 떠 보이지 않는다.
  paper: {
    surface: '#f3eedd', border: '#d9cdae', radius: '0.5rem', pad: '0.625rem',
    bar: 'transparent', barRadius: '0', barPad: '0px',
    accent: '#3c4043', text: '#334155', muted: '#94a3b8', track: '#ded3b4',
    pill: 'rgba(255,255,255,0.7)', pillOn: '#cbd5e1',
  },
};

// 트랙은 선만, 손잡이 점은 손이 닿았을 때만(기본 재생기와 같다) — 지나온 구간은 --tp-pct 로 채운다.
const TRANSPORT_CSS = `
.tp-range{-webkit-appearance:none;appearance:none;width:100%;height:14px;background:transparent;cursor:pointer}
.tp-range::-webkit-slider-runnable-track{height:3px;border-radius:9999px;
  background:linear-gradient(to right,var(--tp-accent) var(--tp-pct,0%),var(--tp-track) var(--tp-pct,0%))}
.tp-range::-moz-range-track{height:3px;border-radius:9999px;
  background:linear-gradient(to right,var(--tp-accent) var(--tp-pct,0%),var(--tp-track) var(--tp-pct,0%))}
.tp-range::-webkit-slider-thumb{-webkit-appearance:none;width:11px;height:11px;margin-top:-4px;
  border-radius:9999px;background:var(--tp-accent);opacity:0;transition:opacity .12s}
.tp-range::-moz-range-thumb{width:11px;height:11px;border:0;border-radius:9999px;
  background:var(--tp-accent);opacity:0;transition:opacity .12s}
.tp-range:hover::-webkit-slider-thumb,.tp-range:active::-webkit-slider-thumb,
.tp-range:focus-visible::-webkit-slider-thumb{opacity:1}
.tp-range:hover::-moz-range-thumb,.tp-range:active::-moz-range-thumb,
.tp-range:focus-visible::-moz-range-thumb{opacity:1}
.tp-btn:focus,.tp-btn:focus-visible,.tp-range:focus,.tp-range:focus-visible{outline:none}`;

export type TransportSpan = { start: number; end: number };

export function AudioTransport({
  src, audioRef: outerRef, onTime, onDur, study = true, theme = 'plain', snapTo = [],
  downloads = [], abA: pAbA, abB: pAbB, setAbA: pSetAbA, setAbB: pSetAbB, preload = 'metadata',
  children,
}: {
  src: string;
  /** 부모가 element 를 만져야 할 때만(노래방 녹음이 WebAudio 로 물린다). 없으면 자기가 든다. */
  audioRef?: React.RefObject<HTMLAudioElement | null>;
  onTime?: (t: number) => void;
  onDur?: (d: number) => void;
  /** 연습 모드 = 배속·전체반복·구간반복 노출. false = 재생+위치+볼륨만. */
  study?: boolean;
  /** 프리셋 이름이거나, 프리셋 위에 덮을 색 몇 개. 표면이 자기 색을 가진다. */
  theme?: keyof typeof TRANSPORT_THEMES | Partial<TransportTheme>;
  /** A-B 를 이 구간 경계에 붙인다(토익 = LRC 단어, 노래방 = 가사 줄). 없으면 raw 시간. */
  snapTo?: TransportSpan[];
  /** 우리가 그리는 ⋮ 내려받기 — 네이티브를 걷었으니 그 자리를 여기서 갚는다. */
  downloads?: Array<{ href: string; label: string }>;
  abA?: number | null; abB?: number | null;
  setAbA?: (t: number | null) => void; setAbB?: (t: number | null) => void;
  preload?: 'none' | 'metadata' | 'auto';
  children?: React.ReactNode;
}) {
  const ownRef = useRef<HTMLAudioElement | null>(null);
  const audioRef = outerRef ?? ownRef;
  const [playing, setPlaying] = useState(false);
  const [cur, setCur] = useState(0);
  const [dur, setDur] = useState(0);
  const [speed, setSpeed] = useState(1);
  const [showSpeed, setShowSpeed] = useState(false);
  const [vol, setVol] = useState(1);
  const [showVol, setShowVol] = useState(false);
  const [loop, setLoop] = useState(false);
  const [menu, setMenu] = useState(false);
  const [ownA, setOwnA] = useState<number | null>(null);
  const [ownB, setOwnB] = useState<number | null>(null);
  const loopingRef = useRef(false); // A-B 되돌아가는 0.5초 사이의 재트리거 방지

  const controlled = !!(pSetAbA && pSetAbB);
  const abA = controlled ? (pAbA ?? null) : ownA;
  const abB = controlled ? (pAbB ?? null) : ownB;
  const setAbA = controlled ? pSetAbA! : setOwnA;
  const setAbB = controlled ? pSetAbB! : setOwnB;

  const th: TransportTheme = typeof theme === 'string'
    ? (TRANSPORT_THEMES[theme] ?? TRANSPORT_THEMES.plain)
    : { ...TRANSPORT_THEMES.plain, ...theme };

  // A-B 경계 붙이기 — t 가 든 구간으로, 빈 자리면 A=다음 구간 시작 / B=이전 구간 끝.
  const snapStart = (t: number) => {
    if (!snapTo.length) return t;
    const inw = snapTo.find((w) => t >= w.start && t < w.end);
    if (inw) return inw.start;
    const next = snapTo.find((w) => w.start >= t);
    return next ? next.start : t;
  };
  const snapEnd = (t: number) => {
    if (!snapTo.length) return t;
    const inw = snapTo.find((w) => t >= w.start && t < w.end);
    if (inw) return inw.end;
    let prev: TransportSpan | undefined;
    for (const w of snapTo) { if (w.end <= t) prev = w; else break; }
    return prev ? prev.end : t;
  };

  // A new file is a new timeline, and the element does not tell us it stopped.
  //
  // Changing `src` runs the HTML media load algorithm, which sets `paused` to true **without
  // firing `pause`** — the spec sets the attribute and queues no event. Our state is driven by
  // the play/pause events, so it stayed on "playing" while the element sat silent, and the
  // position and duration stayed on the previous track. 실측 2026-08-21 (사용자, 미디어 상세):
  // "재생하고 다음껄로 넘어가면 소리는 안나오는데 플레이어는 재생중인듯".
  //
  // Speed, volume and loop are the listener's preferences and survive on purpose; the A-B pair
  // does not, because those marks point at seconds of a track that is no longer loaded. When the
  // parent owns them (karaoke) it is the parent's timeline, so we leave them alone.
  useEffect(() => {
    setPlaying(false);
    setCur(0);
    setDur(0);
    if (!controlled) { setOwnA(null); setOwnB(null); }
  }, [src, controlled]);

  useEffect(() => {
    const a = audioRef.current; if (!a) return;
    const onT = () => {
      setCur(a.currentTime); onTime?.(a.currentTime);
      // B 에 닿으면 0.5초 숨 돌리고 A 로 — 바로 또 시작하면 귀가 못 따라간다.
      if (abA != null && abB != null && abB > abA && a.currentTime >= abB && !loopingRef.current) {
        loopingRef.current = true;
        a.pause();
        setTimeout(() => {
          const aa = audioRef.current;
          if (aa) { aa.currentTime = abA; void aa.play(); }
          loopingRef.current = false;
        }, 500);
      }
    };
    const onMeta = () => { setDur(a.duration || 0); onDur?.(a.duration || 0); };
    const onEnd = () => { if (!a.loop) setPlaying(false); };
    const onPlay = () => setPlaying(true);
    const onPause = () => setPlaying(false);
    a.addEventListener('timeupdate', onT); a.addEventListener('loadedmetadata', onMeta);
    a.addEventListener('durationchange', onMeta); a.addEventListener('ended', onEnd);
    a.addEventListener('play', onPlay); a.addEventListener('pause', onPause);
    onMeta();
    return () => {
      a.removeEventListener('timeupdate', onT); a.removeEventListener('loadedmetadata', onMeta);
      a.removeEventListener('durationchange', onMeta); a.removeEventListener('ended', onEnd);
      a.removeEventListener('play', onPlay); a.removeEventListener('pause', onPause);
    };
  }, [audioRef, abA, abB, onTime, onDur]);

  // 재생 중엔 rAF — timeupdate 는 초당 네 번이라 슬라이더도 가사도 뚝뚝 끊긴다.
  useEffect(() => {
    if (!playing) return;
    let raf = 0;
    const tick = () => {
      const a = audioRef.current;
      if (a && !a.paused) { setCur(a.currentTime); onTime?.(a.currentTime); }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [playing, audioRef, onTime]);

  useEffect(() => { if (audioRef.current) audioRef.current.playbackRate = speed; }, [speed, audioRef]);
  useEffect(() => { if (audioRef.current) audioRef.current.volume = vol; }, [vol, audioRef]);
  useEffect(() => { if (audioRef.current) audioRef.current.loop = loop; }, [loop, audioRef]);

  const toggle = () => {
    const a = audioRef.current; if (!a) return;
    if (a.paused) {
      if (abA != null && (a.currentTime < abA || (abB != null && a.currentTime >= abB))) a.currentTime = abA;
      void a.play(); setPlaying(true);
    } else { a.pause(); setPlaying(false); }
  };
  // 위치를 옮기면 그 자리를 바로 알린다 — timeupdate 를 기다리면 가사가 한 박 늦게 따라온다.
  const seek = (t: number) => { const a = audioRef.current; if (a) { a.currentTime = t; setCur(t); onTime?.(t); } };
  const fmt = (s: number) => {
    if (!isFinite(s) || s < 0) return '0:00';
    const m = Math.floor(s / 60);
    return `${m}:${Math.floor(s % 60).toString().padStart(2, '0')}`;
  };
  const pct = (v: number, max: number) => `${max > 0 ? Math.min(100, Math.max(0, (v / max) * 100)) : 0}%`;
  const pillStyle = (on: boolean) => ({ background: on ? th.pillOn : th.pill, color: on ? th.text : th.muted });
  const pillCls = 'tp-btn px-1.5 py-0.5 rounded leading-none transition-colors';
  // 아이콘 버튼 = 맨몸 글리프 + 손이 닿으면 동그라미(기본 재생기와 같은 손버릇).
  const iconBtn = 'tp-btn w-8 h-8 shrink-0 rounded-full flex items-center justify-center transition-colors hover:bg-black/[0.08]';

  return (
    <span style={{ display: 'block',
                  ['--tp-accent' as string]: th.accent, ['--tp-track' as string]: th.track,
                  background: th.surface, borderColor: th.border, borderRadius: th.radius,
                  padding: th.pad, borderWidth: th.border === 'transparent' ? 0 : 1,
                  borderStyle: 'solid' } as React.CSSProperties}>
      <style>{TRANSPORT_CSS}</style>
      <audio ref={audioRef} src={src} preload={preload} className="hidden" />
      <span className="flex items-center gap-1" style={{ background: th.bar, borderRadius: th.barRadius, padding: th.barPad }}>
        <button type="button" onClick={toggle} aria-label={playing ? '일시정지' : '재생'}
          className={iconBtn} style={{ color: th.accent }}>
          {playing
            ? <svg viewBox="0 0 24 24" fill="currentColor" className="w-[17px] h-[17px]" aria-hidden><path d="M7 5h3.2v14H7zM13.8 5H17v14h-3.2z" /></svg>
            : <svg viewBox="0 0 24 24" fill="currentColor" className="w-[17px] h-[17px] ml-0.5" aria-hidden><path d="M8 5v14l11-7z" /></svg>}
        </button>
        <span className="text-[12px] tabular-nums shrink-0 px-1" style={{ color: th.muted }}>{fmt(cur)} / {fmt(dur)}</span>
        <input type="range" min={0} max={dur || 0} step={0.05} value={Math.min(cur, dur || 0)}
          onChange={(e) => seek(Number(e.target.value))} aria-label="재생 위치"
          className="tp-range flex-1 mx-1" style={{ ['--tp-pct' as string]: pct(cur, dur) } as React.CSSProperties} />
        {/* 볼륨 = 손이 닿으면 **왼쪽으로 펼쳐지는 한 줄**(기본 재생기와 같은 손버릇). 상자를
            띄우지 않으니 아래 줄이 밀리지 않는다. hover 가 없는 화면(터치)에선 탭이 같은 일을. */}
        <span className={`group/vol flex items-center rounded-full shrink-0 ${showVol ? 'bg-black/[0.06]' : ''}`}>
          <span className={`overflow-hidden transition-[width,opacity] duration-150 ${showVol ? 'w-20 opacity-100' : 'w-0 opacity-0 group-hover/vol:w-20 group-hover/vol:opacity-100'}`}>
            <input type="range" min={0} max={1} step={0.05} value={vol}
              onChange={(e) => setVol(Number(e.target.value))} aria-label="볼륨"
              className="tp-range w-20 px-2 align-middle"
              style={{ ['--tp-pct' as string]: pct(vol, 1) } as React.CSSProperties} />
          </span>
          {/* 아이콘이 곧 눈금 — 음소거·한 칸·두 칸. 숫자를 따로 안 적어도 상태가 보인다. */}
          <button type="button" onClick={() => setShowVol((v) => !v)} style={{ color: th.muted }}
            aria-label={`볼륨 ${Math.round(vol * 100)}`} className={iconBtn}>
            <svg width="17" height="17" viewBox="0 0 24 24" aria-hidden>
              <path fill="currentColor" d="M4 9.5v5h3.2L12 18.5v-13L7.2 9.5H4z" />
              {vol > 0.02 ? (
                <>
                  <path d="M15.2 9.2a4 4 0 0 1 0 5.6" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
                  {vol > 0.5 && <path d="M17.7 6.7a7.5 7.5 0 0 1 0 10.6" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />}
                </>
              ) : (
                <path d="M15.6 9.6l4.8 4.8m0-4.8l-4.8 4.8" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
              )}
            </svg>
          </button>
        </span>
        {downloads.length > 0 && (
          <span className="relative shrink-0">
            <button type="button" aria-label="내려받기" onClick={() => setMenu((v) => !v)}
              className={iconBtn} style={{ color: th.muted }}>
              <svg viewBox="0 0 24 24" fill="currentColor" className="w-[17px] h-[17px]" aria-hidden><circle cx="12" cy="5" r="1.7" /><circle cx="12" cy="12" r="1.7" /><circle cx="12" cy="19" r="1.7" /></svg>
            </button>
            {menu && (
              <>
                <span className="fixed inset-0 z-10" onClick={() => setMenu(false)} />
                <span className="absolute right-0 top-9 z-20 min-w-[7rem] rounded-lg border border-slate-200 bg-white shadow-lg py-1 flex flex-col">
                  {downloads.map((d) => (
                    <a key={d.label} href={d.href} download onClick={() => setMenu(false)}
                      className="px-3 py-1.5 text-[12px] text-slate-600 hover:bg-slate-50">{d.label}</a>
                  ))}
                </span>
              </>
            )}
          </span>
        )}
      </span>
      {/* 둘째 줄 = 연습 도구(배속·전체반복·구간). 없는 모드엔 줄 자체가 안 선다 — 볼륨은 위
          막대에 있어 계속 쓸 수 있다. */}
      {study && (
        <span className="flex flex-wrap items-center gap-x-1.5 gap-y-2 mt-2 text-[11px]">
          <span className="relative flex items-center gap-1.5">
            <span style={{ color: th.muted }}>속도</span>
            <button type="button" onClick={() => setShowSpeed((v) => !v)} className={pillCls} style={pillStyle(showSpeed)}>{speed.toFixed(1)}x</button>
            {showSpeed && (
              // 팝오버(흐름 밖) — 다른 컨트롤 위에 떠서 줄 밀림 0. 슬라이더를 놓으면 닫힌다.
              <span className="absolute left-0 top-full mt-1 z-30 flex items-center gap-2 rounded-lg border border-slate-200 bg-white px-3 py-2 shadow-lg w-52">
                <input type="range" min={0.1} max={3} step={0.1} value={speed}
                  onChange={(e) => setSpeed(Math.round(Number(e.target.value) * 10) / 10)}
                  onPointerUp={() => setShowSpeed(false)} aria-label="재생 속도"
                  className="tp-range flex-1" style={{ ['--tp-pct' as string]: pct(speed - 0.1, 2.9) } as React.CSSProperties} />
                <span className="w-9 text-right tabular-nums text-slate-500">{speed.toFixed(1)}x</span>
              </span>
            )}
          </span>
          <button type="button" onClick={() => setLoop((v) => !v)} className={pillCls} style={pillStyle(loop)} title="전체 반복">↻</button>
          <span className="ml-1" style={{ color: th.muted }}>구간</span>
          <button type="button" onClick={() => setAbA(snapStart(cur))} className={pillCls} style={pillStyle(abA != null)} title="구간 시작(A) — 현재 위치">A</button>
          <button type="button" onClick={() => setAbB(snapEnd(cur))} className={pillCls} style={pillStyle(abB != null)} title="구간 끝(B) — 현재 위치">B</button>
          {(abA != null || abB != null) && (
            <button type="button" onClick={() => { setAbA(null); setAbB(null); }} className={pillCls} style={pillStyle(false)} title="구간 해제">✕</button>
          )}
        </span>
      )}
      {children}
    </span>
  );
}

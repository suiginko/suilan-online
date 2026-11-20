import { useEffect, useMemo, useRef, useState } from 'react';
import { GameState, WordEntry } from '../types';
import { EMPTY_BANK, MIN_BANK_WORDS, ParsedBank, altListOf, decodeTextFile, parseWordList, wordKey } from '../bankText';

interface Props {
  state: GameState;
  isHost: boolean;
  isReferee?: boolean;
  isDev: boolean;
  onProposeFile: (file: File, passphrase: string) => Promise<void>;
  onProposeText: (name: string, words: WordEntry[]) => Promise<void>;
  onProposeDemo: () => Promise<void>;
  onApprove: (id: string) => void;
  onReject: (id: string) => void;
}

type Mode = 'text' | 'pack';

/** 预览列表里的一行：id 只用来做稳定的 React key，word 才是会被提交的内容 */
interface DraftWord {
  id: number;
  word: string;
  /** 斜杠写法拆出来的其它别名：只影响判对，不在游戏里显示 */
  alt?: string[];
  hint?: string;
  category?: string;
}

/**
 * 题库面板：房间里任何人都能上传，房主点头后才生效。
 *
 * 两条导入路线：
 *   明文词库 —— 粘贴/上传文本，任意分隔自动识别，识别结果就在下面，可以逐条改。
 *   加密包   —— .sbank 密文 + 口令，词表在服务端解密。
 * 无论哪条路，词表都只进服务端 vault：公开快照里只有名字、词数、指纹。
 */
export function BankPanel({ state, isHost, isReferee, isDev, onProposeFile, onProposeText, onProposeDemo, onApprove, onReject }: Props) {
  const [open, setOpen] = useState(false);
  const [mode, setMode] = useState<Mode>('text');
  const [src, setSrc] = useState('');
  const [parsed, setParsed] = useState<ParsedBank>(EMPTY_BANK);
  const [draft, setDraft] = useState<DraftWord[]>([]);
  const [bankName, setBankName] = useState('手动词库');
  const [pass, setPass] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const packRef = useRef<HTMLInputElement>(null);
  const textRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const cardRef = useRef<HTMLDivElement>(null);
  const seq = useRef(0);

  // 题库面板在右侧窄栏，展开后编辑区常常落在折叠线以下：随手把它带进视野
  useEffect(() => {
    if (open) cardRef.current?.scrollIntoView({ block: 'nearest' });
  }, [open]);

  const canDecide = isHost || isReferee || isDev;
  const canUpload = state.phase === 'lobby' || isReferee || isDev;
  const lobby = canUpload;
  const proposals = state.bankProposals ?? [];

  /** 当前草稿里真正能提交的词：去空白、去重（与服务端同一口径） */
  const { words: usable, dropped } = useMemo(() => {
    const seen = new Set<string>();
    const out: WordEntry[] = [];
    let drop = 0;
    for (const row of draft) {
      const word = row.word.trim();
      if (!word) {
        drop++;
        continue;
      }
      const key = wordKey(word);
      if (seen.has(key)) {
        drop++;
        continue;
      }
      seen.add(key);
      const entry: WordEntry = { word };
      const alts = altListOf(row.alt, word);
      if (alts.length) entry.alt = alts;
      if (row.hint) entry.hint = row.hint;
      if (row.category) entry.category = row.category;
      out.push(entry);
    }
    return { words: out, dropped: drop };
  }, [draft]);

  // 合并的数量 = 解析时就去掉的重复 + 用户后来又改重复的行
  const merged = parsed.duplicates + dropped;
  const withAlt = usable.filter((w) => w.alt?.length).length;
  const stats = [
    `${usable.length} 词`,
    withAlt ? `含别名 ${withAlt}` : '',
    merged ? `去重 ${merged}` : '',
    parsed.ignored ? `忽略 ${parsed.ignored}` : '',
    parsed.truncated ? `超出上限 ${parsed.truncated}` : '',
  ]
    .filter(Boolean)
    .join(' · ');

  /** 文本任何变化都重新识别一次：预览是跟着输入的，不需要点「解析」 */
  const ingest = (text: string) => {
    setSrc(text);
    const next = parseWordList(text);
    setParsed(next);
    setDraft(
      next.entries.map((e) => ({ id: ++seq.current, word: e.word, alt: e.alt, hint: e.hint, category: e.category }))
    );
    setErr(null);
  };

  const readTextFile = async (file: File) => {
    try {
      const text = decodeTextFile(await file.arrayBuffer());
      ingest(text);
      const base = file.name.replace(/\.[^.]+$/, '').trim().slice(0, 20);
      if (base) setBankName(base);
    } catch (e) {
      setErr(`文件读不出来：${(e as Error).message}`);
    }
  };

  const resetText = () => {
    ingest('');
    setBankName('手动词库');
  };

  const setRowWord = (id: number, word: string) =>
    setDraft((prev) => prev.map((r) => (r.id === id ? { ...r, word } : r)));

  const removeRow = (id: number) => setDraft((prev) => prev.filter((r) => r.id !== id));

  const addRow = () => {
    const id = ++seq.current;
    setDraft((prev) => [...prev, { id, word: '' }]);
    requestAnimationFrame(() => {
      const box = listRef.current;
      if (box) box.scrollTop = box.scrollHeight;
    });
  };

  const submitText = async () => {
    if (usable.length < MIN_BANK_WORDS) {
      setErr(`至少要 ${MIN_BANK_WORDS} 个不同的词，现在 ${usable.length} 个`);
      return;
    }
    setErr(null);
    setBusy(true);
    try {
      await onProposeText(bankName.trim() || '手动词库', usable);
      resetText();
      setOpen(false);
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const submitPack = async () => {
    const file = packRef.current?.files?.[0];
    if (!file) return setErr('先选择 .sbank 题库文件');
    if (!pass) return setErr('请输入题库口令');
    setErr(null);
    setBusy(true);
    try {
      await onProposeFile(file, pass);
      setPass('');
      if (packRef.current) packRef.current.value = '';
      setOpen(false);
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const doDemo = async () => {
    setErr(null);
    setBusy(true);
    try {
      await onProposeDemo();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const editor =
    mode === 'text' ? (
      <div className="stack" style={{ gap: 8 }}>
        <textarea
          className="input bank-src"
          rows={5}
          value={src}
          placeholder="粘贴词表：换行、逗号、顿号、空格都算分隔"
          title="也可以每行「词|提示|分类」"
          onChange={(e) => ingest(e.target.value)}
          aria-label="词表原文"
        />
        <div className="row" style={{ gap: 8 }}>
          <button className="btn grow" onClick={() => textRef.current?.click()}>
            读入文本文件
          </button>
          <input
            ref={textRef}
            type="file"
            accept=".txt,.csv,.md,.text,text/plain"
            style={{ display: 'none' }}
            onChange={(e) => {
              const file = e.target.files?.[0];
              if (file) void readTextFile(file);
              e.target.value = '';
            }}
          />
          <button className="btn" onClick={resetText} disabled={!src && !draft.length}>
            清空
          </button>
        </div>

        {draft.length ? (
          <div className="bank-list" ref={listRef}>
            {draft.map((row, i) => (
              <div className="bank-row" key={row.id}>
                <span className="bank-idx">{i + 1}</span>
                <input
                  className="bank-word"
                  value={row.word}
                  title={row.hint ?? undefined}
                  aria-label={`第 ${i + 1} 个词`}
                  onChange={(e) => setRowWord(row.id, e.target.value)}
                />
                {row.alt?.length ? (
                  <span className="bank-alt" title={`这些写法也算答对：${row.alt.join('、')}`}>
                    别名 {row.alt.length}
                  </span>
                ) : null}
                <button
                  className="bank-del"
                  onClick={() => removeRow(row.id)}
                  aria-label={`删除第 ${i + 1} 个词`}
                >
                  ×
                </button>
              </div>
            ))}
          </div>
        ) : (
          <p className="small muted">还没有识别到词</p>
        )}

        <div className="row-between">
          <span className="small muted">{draft.length ? stats : ''}</span>
          <button className="btn" style={{ padding: '4px 10px', fontSize: 12 }} onClick={addRow}>
            ＋ 加一行
          </button>
        </div>

        <div className="row" style={{ gap: 8 }}>
          <input
            className="input"
            style={{ flex: '1 1 auto', minWidth: 0 }}
            placeholder="题库名"
            maxLength={20}
            value={bankName}
            onChange={(e) => setBankName(e.target.value)}
            aria-label="题库名"
          />
          <button className="btn btn-primary" onClick={submitText} disabled={busy}>
            {busy ? '提交中…' : '提交审批'}
          </button>
        </div>
      </div>
    ) : (
      <div className="stack" style={{ gap: 8 }}>
        <input ref={packRef} type="file" accept=".sbank,.json,application/json" className="input" />
        <div className="row">
          <input
            className="input"
            type="password"
            placeholder="题库口令"
            value={pass}
            onChange={(e) => setPass(e.target.value)}
          />
          <button className="btn btn-primary" onClick={submitPack} disabled={busy}>
            {busy ? '上传中…' : '提交审批'}
          </button>
        </div>
      </div>
    );

  return (
    <div className="card stack" ref={cardRef} style={{ gap: 10 }}>
      <div className="row-between">
        <h2 style={{ fontSize: 14 }}>题库</h2>
        {state.bank ? <span className="pill pill-gold">已就绪</span> : <span className="pill">待导入</span>}
      </div>

      {state.bank ? (
        <div className="stack" style={{ gap: 2 }}>
          <div className="row-between">
            <strong style={{ fontWeight: 500 }}>{state.bank.name}</strong>
            <span className="small muted">{state.bank.count} 词</span>
          </div>
          <span className="tiny faint mono">指纹 {state.bank.fingerprint}</span>
        </div>
      ) : (
        <p className="small muted">尚未导入题库</p>
      )}

      {proposals.length ? (
        <div className="stack" style={{ gap: 8 }}>
          <span className="tiny faint">待审批</span>
          {proposals.map((p) => (
            <div key={p.id} className="proposal">
              <div className="stack" style={{ gap: 1 }}>
                <strong style={{ fontWeight: 500, fontSize: 13 }}>{p.name}</strong>
                <span className="tiny faint">
                  {p.count} 词 · 由 {p.by} 提交
                </span>
              </div>
              {canDecide ? (
                <div className="row" style={{ gap: 6 }}>
                  <button className="btn btn-primary" style={{ padding: '5px 12px', fontSize: 12 }} onClick={() => onApprove(p.id)}>
                    同意
                  </button>
                  <button className="btn" style={{ padding: '5px 12px', fontSize: 12 }} onClick={() => onReject(p.id)}>
                    拒绝
                  </button>
                </div>
              ) : (
                <span className="pill pill-blue">等待房主/裁判审批</span>
              )}
            </div>
          ))}
        </div>
      ) : null}

      {lobby ? (
        open ? (
          <div className="stack" style={{ gap: 8 }}>
            <div className="seg">
              <button
                className={`seg-btn ${mode === 'text' ? 'is-on' : ''}`}
                aria-pressed={mode === 'text'}
                onClick={() => {
                  setMode('text');
                  setErr(null);
                }}
              >
                明文词库
              </button>
              <button
                className={`seg-btn ${mode === 'pack' ? 'is-on' : ''}`}
                aria-pressed={mode === 'pack'}
                onClick={() => {
                  setMode('pack');
                  setErr(null);
                }}
              >
                加密包
              </button>
            </div>
            {editor}
            <div className="row" style={{ justifyContent: 'flex-end' }}>
              <button
                className="btn"
                style={{ padding: '5px 10px', fontSize: 12 }}
                onClick={() => {
                  setOpen(false);
                  setErr(null);
                }}
              >
                收起
              </button>
            </div>
          </div>
        ) : (
          <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
            <button className="btn" onClick={() => setOpen(true)}>
              导入题库…
            </button>
            <button className="btn btn-gold" onClick={doDemo} disabled={busy}>
              用内置示例题库
            </button>
          </div>
        )
      ) : (
        <p className="tiny faint">对局中不可更换题库</p>
      )}

      {err ? <p className="small" style={{ color: 'var(--red)' }}>{err}</p> : null}
    </div>
  );
}

import { useEffect, useMemo, useRef, useState } from 'react';
import {
  ArrowLeft,
  BookOpen,
  Check,
  ChevronRight,
  CircleHelp,
  Clock3,
  Download,
  FileText,
  Film,
  FolderOpen,
  Gauge,
  KeyRound,
  LoaderCircle,
  Maximize2,
  Pause,
  Play,
  Plus,
  Search,
  Settings2,
  Sparkles,
  Trash2,
  Upload,
  WandSparkles,
  X,
} from 'lucide-react';
import { deleteVideoBlob, getVideoBlob, saveVideoBlob } from './storage';
import { cleanWord, downloadText, formatClock, makeSrt, makeVtt } from './subtitles';

const PROJECTS_KEY = 'recnik-projects-v1';

const DEMO_SEGMENTS = [
  { id: 'd1', start: 0, end: 4.4, text: 'Добро дошли у Београд, град који никада не мирује.' },
  { id: 'd2', start: 4.4, end: 8.8, text: 'Данас ћемо прошетати старим улицама Дорћола.' },
  { id: 'd3', start: 8.8, end: 13.2, text: 'Овде се традиција и савремени живот сусрећу на сваком кораку.' },
  { id: 'd4', start: 13.2, end: 17.8, text: 'Мирис свеже кафе стиже из малих породичних кафана.' },
  { id: 'd5', start: 17.8, end: 22.2, text: 'Људи разговарају, смеју се и уживају у сунчаном дану.' },
  { id: 'd6', start: 22.2, end: 27.4, text: 'На крају улице види се Дунав, широк и миран.' },
  { id: 'd7', start: 27.4, end: 32, text: 'Свака реч открива још један део овог града.' },
];

function loadProjects() {
  try {
    return JSON.parse(localStorage.getItem(PROJECTS_KEY) || '[]');
  } catch {
    return [];
  }
}

function fileStem(filename = 'video') {
  return filename.replace(/\.[^.]+$/, '').replace(/[^a-zа-я0-9_-]+/giu, '-').replace(/^-|-$/g, '') || 'video';
}

function normalizeTranscription(payload) {
  if (Array.isArray(payload.segments) && payload.segments.length) {
    return payload.segments.map((segment, index) => ({
      id: `s-${index}-${Math.round(Number(segment.start || 0) * 100)}`,
      start: Number(segment.start || 0),
      end: Number(segment.end ?? Number(segment.start || 0) + 3),
      text: String(segment.text || '').trim(),
    })).filter((segment) => segment.text);
  }

  if (Array.isArray(payload.words) && payload.words.length) {
    const groups = [];
    for (let index = 0; index < payload.words.length; index += 9) {
      const words = payload.words.slice(index, index + 9);
      groups.push({
        id: `w-${index}`,
        start: Number(words[0]?.start || 0),
        end: Number(words.at(-1)?.end || Number(words[0]?.start || 0) + 4),
        text: words.map((word) => word.word).join(' ').trim(),
      });
    }
    return groups;
  }

  if (payload.text) return [{ id: 'full', start: 0, end: 99999, text: payload.text.trim() }];
  return [];
}

function formatBytes(size = 0) {
  if (size < 1024 * 1024) return `${Math.max(1, Math.round(size / 1024))} КБ`;
  return `${(size / 1024 / 1024).toFixed(1)} МБ`;
}

function pluralizeRu(number, one, few, many) {
  const mod100 = Math.abs(number) % 100;
  const mod10 = mod100 % 10;
  if (mod100 > 10 && mod100 < 20) return many;
  if (mod10 === 1) return one;
  if (mod10 >= 2 && mod10 <= 4) return few;
  return many;
}

function PatternBand({ vertical = false }) {
  return <div className={`pattern-band ${vertical ? 'pattern-band--vertical' : ''}`} aria-hidden="true" />;
}

function BrandMark() {
  return (
    <img className="brand-wolf" src="/assets/citavuk-logo.webp" alt="" aria-hidden="true" />
  );
}

function Header({ inProject, onHome, onSettings }) {
  return (
    <header className="site-header">
      <button className="brand" onClick={onHome} aria-label="На главную">
        <BrandMark />
        <span className="brand-copy"><strong>ЧИТАВУК-РЕЧНИК</strong><small>српски видео-речник</small></span>
      </button>
      <div className="header-actions">
        {inProject && (
          <button className="text-button" onClick={onHome}>
            <FolderOpen size={17} /> Мои видео
          </button>
        )}
        <button className="icon-button" onClick={onSettings} aria-label="Настройки API">
          <Settings2 size={20} />
        </button>
      </div>
    </header>
  );
}

function UploadZone({ onFile }) {
  const inputRef = useRef(null);
  const [dragging, setDragging] = useState(false);

  const takeFile = (files) => {
    const file = files?.[0];
    if (file) onFile(file);
  };

  return (
    <div
      className={`upload-zone ${dragging ? 'is-dragging' : ''}`}
      onDragOver={(event) => { event.preventDefault(); setDragging(true); }}
      onDragLeave={() => setDragging(false)}
      onDrop={(event) => { event.preventDefault(); setDragging(false); takeFile(event.dataTransfer.files); }}
      onClick={() => inputRef.current?.click()}
      role="button"
      tabIndex={0}
      onKeyDown={(event) => event.key === 'Enter' && inputRef.current?.click()}
    >
      <input
        ref={inputRef}
        type="file"
        accept="video/*,.mkv,.avi,.mov,.m4v"
        hidden
        onChange={(event) => takeFile(event.target.files)}
      />
      <div className="upload-icon"><Upload size={27} strokeWidth={1.7} /></div>
      <strong>Перетащите видео сюда</strong>
      <span>или нажмите, чтобы выбрать файл</span>
      <p className="upload-formats">Поддерживаются MP4, MOV, WEBM и MKV. Максимальный размер исходного видео составляет 500 МБ.</p>
    </div>
  );
}

function RecentProject({ project, onOpen, onDelete }) {
  return (
    <article className="recent-card" onClick={() => onOpen(project.id)}>
      <div className="recent-thumb">
        <Film size={22} />
        <span>{project.transcript?.length ? 'SR' : '—'}</span>
      </div>
      <div className="recent-copy">
        <strong>{project.name}</strong>
        <span>{project.transcript?.length || 0} {pluralizeRu(project.transcript?.length || 0, 'фрагмент', 'фрагмента', 'фрагментов')}, {project.glossary?.length || 0} {pluralizeRu(project.glossary?.length || 0, 'слово', 'слова', 'слов')} в словаре</span>
      </div>
      <button
        className="subtle-icon"
        onClick={(event) => { event.stopPropagation(); onDelete(project.id); }}
        aria-label="Удалить проект"
      >
        <Trash2 size={16} />
      </button>
      <ChevronRight size={18} className="recent-arrow" />
    </article>
  );
}

function Landing({ onFile, onDemo, projects, onOpen, onDelete }) {
  return (
    <main className="landing">
      <div className="side-ornament side-ornament--left"><PatternBand vertical /></div>
      <div className="side-ornament side-ornament--right"><PatternBand vertical /></div>

      <section className="hero">
        <div className="hero-copy">
          <h1>Сервис для создания субтитров к сербскому видео.</h1>
          <p>Загрузите ролик, получите синхронный сербский текст и собирайте личный словарь прямо во время просмотра.</p>
          <div className="hero-limits">
            <p>Бесплатный тариф Groq позволяет выполнить 2 000 запросов в сутки и распознать до двух часов аудио в час или до восьми часов в сутки. После сжатия аудиофайл должен занимать не более 25 МБ.</p>
          </div>
          <img className="hero-wolf" src="/assets/citavuk-guide.webp" alt="Читавук помогает разобраться с субтитрами" />
        </div>

        <div className="upload-card">
          <div className="card-title">
            <div><span>НОВОЕ ВИДЕО</span><h2>Начать разбор</h2></div>
            <div className="free-seal"><Sparkles size={14} /> FREE</div>
          </div>
          <UploadZone onFile={onFile} />
          <button className="demo-link" onClick={onDemo}><Play size={14} fill="currentColor" /> Открыть пример проекта</button>
          <div className="privacy-note"><KeyRound size={15} /> Видео остается в памяти вашего браузера</div>
        </div>
      </section>

      <PatternBand />

      <section className="process-story">
        <BookOpen size={25} />
        <p>Читавук распознаёт сербскую речь, синхронизирует текст с видео и делает каждое слово интерактивным. Во время просмотра незнакомое слово можно добавить в личный словарь, а готовый результат сохранить как VTT, SRT или MP4 со встроенными субтитрами.</p>
      </section>

      {projects.length > 0 && (
        <section className="recent-section">
          <div className="section-heading"><div><span>ВАША ПОЛКА</span><h2>Недавние видео</h2></div><small>{projects.length} {pluralizeRu(projects.length, 'проект', 'проекта', 'проектов')}</small></div>
          <div className="recent-list">
            {projects.slice(0, 4).map((project) => <RecentProject key={project.id} project={project} onOpen={onOpen} onDelete={onDelete} />)}
          </div>
        </section>
      )}
    </main>
  );
}

function DemoPlayer({ currentTime, onTime, activeSegment }) {
  const [playing, setPlaying] = useState(false);
  useEffect(() => {
    if (!playing) return undefined;
    const timer = setInterval(() => onTime((currentTime + 0.1) % 32), 100);
    return () => clearInterval(timer);
  }, [playing, currentTime, onTime]);

  return (
    <div className="demo-player">
      <div className="demo-sun" />
      <div className="demo-city"><i /><i /><i /><i /><i /><i /></div>
      <div className="demo-grain" />
      <div className="demo-label"><span>ДОРЋОЛ</span><small>Београд, 2026</small></div>
      {activeSegment && <div className="subtitle-overlay">{activeSegment.text}</div>}
      <div className="demo-controls">
        <button onClick={() => setPlaying(!playing)} aria-label={playing ? 'Пауза' : 'Воспроизвести'}>
          {playing ? <Pause size={17} fill="currentColor" /> : <Play size={17} fill="currentColor" />}
        </button>
        <div className="demo-progress" onClick={(event) => onTime((event.nativeEvent.offsetX / event.currentTarget.clientWidth) * 32)}>
          <span style={{ width: `${(currentTime / 32) * 100}%` }} />
        </div>
        <small>{formatClock(currentTime)} / 0:32</small>
        <Maximize2 size={16} />
      </div>
    </div>
  );
}

function VideoPanel({ project, videoUrl, videoRef, currentTime, onTime, activeSegment, onTranscribe, processing }) {
  return (
    <section className="video-column">
      <div className="project-kicker"><span>РАЗБОР ВИДЕО</span><small>{project.isDemo ? 'пример проекта' : `${formatBytes(project.size)}, ${project.type || 'видео'}`}</small></div>
      <div className="video-shell">
        {project.isDemo ? (
          <DemoPlayer currentTime={currentTime} onTime={onTime} activeSegment={activeSegment} />
        ) : videoUrl ? (
          <div className="real-player">
            <video ref={videoRef} src={videoUrl} controls onTimeUpdate={(event) => onTime(event.currentTarget.currentTime)} />
            {activeSegment && <div className="subtitle-overlay">{activeSegment.text}</div>}
          </div>
        ) : (
          <div className="missing-video"><Film size={32} /><strong>Исходное видео не найдено</strong><span>Загрузите файл заново, чтобы продолжить.</span></div>
        )}
      </div>
      {!project.transcript?.length && (
        <div className="transcribe-callout">
          <div className="callout-icon"><WandSparkles size={22} /></div>
          <div><strong>Видео готово к распознаванию</strong><span>Читавук распознает сербскую кириллицу или latinica и добавит точные таймкоды.</span></div>
          <button className="primary-button" onClick={onTranscribe} disabled={Boolean(processing)}>
            {processing === 'transcribe' ? <LoaderCircle className="spin" size={18} /> : <Sparkles size={17} />}
            {processing === 'transcribe' ? 'Слушаем речь…' : 'Создать субтитры'}
          </button>
        </div>
      )}
    </section>
  );
}

function WordToken({ value, added, onAdd }) {
  const cleaned = cleanWord(value);
  if (!cleaned) return <>{value} </>;
  const leading = value.match(/^[^\p{L}]+/u)?.[0] || '';
  const trailing = value.match(/[^\p{L}]+$/u)?.[0] || '';
  const token = value.slice(leading.length, trailing ? -trailing.length : undefined);
  return (
    <>
      {leading}
      <button className={`word-token ${added ? 'is-saved' : ''}`} onClick={() => onAdd(cleaned)} title={added ? 'Уже в словаре' : 'Добавить в словарь'}>
        {token}
      </button>
      {trailing}{' '}
    </>
  );
}

function TranscriptPanel({ project, currentTime, onSeek, onAddWord, search, onSearch, onDownloadVtt, onDownloadSrt, onRetranscribe, processing }) {
  const transcript = project.transcript || [];
  const saved = useMemo(() => new Set((project.glossary || []).map((item) => item.word)), [project.glossary]);
  const visible = transcript.filter((segment) => segment.text.toLocaleLowerCase('sr').includes(search.toLocaleLowerCase('sr')));

  return (
    <section className="transcript-panel">
      <div className="panel-header">
        <div><span className="panel-eyebrow">ТРАНСКРИПТ</span><h2>Текст видео</h2></div>
        {transcript.length > 0 && (
          <div className="panel-actions">
            <button onClick={onRetranscribe} disabled={processing === 'transcribe'} title="Распознать заново"><Sparkles size={15} /> Повторить</button>
            <button onClick={onDownloadVtt}><Download size={15} /> VTT</button>
            <button onClick={onDownloadSrt}><Download size={15} /> SRT</button>
          </div>
        )}
      </div>
      {transcript.length > 0 ? (
        <>
          <div className="transcript-tools">
            <div className="search-box"><Search size={16} /><input value={search} onChange={(event) => onSearch(event.target.value)} placeholder="Найти в тексте…" /></div>
            <span><span className="click-dot" /> Нажмите на слово, чтобы сохранить</span>
          </div>
          <div className="segments">
            {visible.map((segment) => {
              const active = currentTime >= segment.start && currentTime < segment.end;
              return (
                <article key={segment.id} className={`segment ${active ? 'is-active' : ''}`}>
                  <button className="segment-time" onClick={() => onSeek(segment.start)}>{formatClock(segment.start)}</button>
                  <p>{segment.text.split(/\s+/).map((word, index) => (
                    <WordToken key={`${word}-${index}`} value={word} added={saved.has(cleanWord(word))} onAdd={(cleaned) => onAddWord(cleaned, segment.start)} />
                  ))}</p>
                  {active && <span className="playing-bars"><i /><i /><i /></span>}
                </article>
              );
            })}
            {!visible.length && <div className="empty-search">Ничего не найдено по запросу «{search}»</div>}
          </div>
        </>
      ) : (
        <div className="empty-transcript">
          <div><FileText size={29} /></div>
          <strong>Здесь появится текст</strong>
          <p>После распознавания фразы синхронизируются с видео. Каждое слово станет интерактивным.</p>
        </div>
      )}
    </section>
  );
}

function GlossaryPanel({ project, onChangeItem, onRemove, onSeek, onBurn, processing }) {
  const [query, setQuery] = useState('');
  const glossary = (project.glossary || []).filter((item) => item.word.includes(query.toLocaleLowerCase('sr')) || item.translation?.toLocaleLowerCase('ru').includes(query.toLocaleLowerCase('ru')));

  return (
    <aside className="glossary-panel">
      <div className="glossary-top">
        <div className="dictionary-icon"><BookOpen size={21} /></div>
        <div><span>ЛИЧНЫЙ СЛОВАРЬ</span><h2>Читавук-речник <b>{project.glossary?.length || 0}</b></h2></div>
      </div>
      {(project.glossary?.length || 0) > 0 && (
        <div className="glossary-search"><Search size={15} /><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Найти слово…" /></div>
      )}
      <div className="glossary-list">
        {glossary.map((item, index) => (
          <article className="word-card" key={item.id}>
            <span className="word-index">{String(index + 1).padStart(2, '0')}</span>
            <div className="word-card-main">
              <div className="word-card-title">
                <strong>{item.word}</strong>
                <button onClick={() => onSeek(item.time)}><Clock3 size={13} /> {formatClock(item.time)}</button>
              </div>
              <input
                value={item.translation || ''}
                onChange={(event) => onChangeItem(item.id, { translation: event.target.value })}
                placeholder="Добавить перевод…"
                aria-label={`Перевод слова ${item.word}`}
              />
              <textarea
                value={item.note || ''}
                onChange={(event) => onChangeItem(item.id, { note: event.target.value })}
                placeholder="Заметка или пример"
                rows={1}
              />
            </div>
            <button className="remove-word" onClick={() => onRemove(item.id)} aria-label={`Удалить ${item.word}`}><X size={15} /></button>
          </article>
        ))}
        {!glossary.length && (
          <div className="empty-glossary">
            <div className="empty-book"><BookOpen size={27} /><Plus size={14} /></div>
            <strong>{query ? 'Слово не найдено' : 'Словарь пока пуст'}</strong>
            <p>{query ? 'Попробуйте другой запрос.' : 'Нажимайте на незнакомые слова в тексте — они появятся здесь.'}</p>
          </div>
        )}
      </div>
      <div className="glossary-footer">
        <button className="burn-button" onClick={onBurn} disabled={!project.transcript?.length || processing === 'burn' || project.isDemo}>
          {processing === 'burn' ? <LoaderCircle size={18} className="spin" /> : <Download size={18} />}
          <span><strong>{processing === 'burn' ? 'Собираем MP4…' : 'MP4 с субтитрами'}</strong><small>{project.isDemo ? 'недоступно в демо' : 'титры вшиты в видео'}</small></span>
        </button>
      </div>
    </aside>
  );
}

function Workspace({ project, videoUrl, videoFile, onBack, onUpdate, onTranscribe, onBurn, processing, notify }) {
  const [currentTime, setCurrentTime] = useState(0);
  const [search, setSearch] = useState('');
  const videoRef = useRef(null);
  const activeSegment = project.transcript?.find((segment) => currentTime >= segment.start && currentTime < segment.end);

  const seek = (time) => {
    setCurrentTime(time);
    if (videoRef.current) {
      videoRef.current.currentTime = time;
      videoRef.current.play().catch(() => {});
    }
  };

  const addWord = (word, time) => {
    if (!word) return;
    if (project.glossary?.some((item) => item.word === word)) {
      notify(`«${word}» уже есть в словаре`);
      return;
    }
    onUpdate({ glossary: [...(project.glossary || []), { id: crypto.randomUUID(), word, translation: '', note: '', time }] });
    notify(`«${word}» добавлено в словарь`);
  };

  const changeItem = (id, patch) => onUpdate({
    glossary: project.glossary.map((item) => item.id === id ? { ...item, ...patch } : item),
  });

  const removeItem = (id) => onUpdate({ glossary: project.glossary.filter((item) => item.id !== id) });
  const filename = fileStem(project.name);

  return (
    <main className="workspace">
      <div className="project-bar">
        <button onClick={onBack}><ArrowLeft size={17} /> К проектам</button>
        <div className="project-title"><span className="status-dot" /><strong>{project.name}</strong><span>сохранено локально</span></div>
        <div className="project-meta"><Gauge size={15} /><span>{project.transcript?.length ? `${project.transcript.length} фрагментов` : 'ожидает обработки'}</span></div>
      </div>
      <div className="workspace-grid">
        <div className="workspace-main">
          <VideoPanel
            project={project}
            videoUrl={videoUrl}
            videoRef={videoRef}
            currentTime={currentTime}
            onTime={setCurrentTime}
            activeSegment={activeSegment}
            onTranscribe={onTranscribe}
            processing={processing}
          />
          <TranscriptPanel
            project={project}
            currentTime={currentTime}
            onSeek={seek}
            onAddWord={addWord}
            search={search}
            onSearch={setSearch}
            onDownloadVtt={() => downloadText(makeVtt(project.transcript), `${filename}-sr.vtt`, 'text/vtt;charset=utf-8')}
            onDownloadSrt={() => downloadText(makeSrt(project.transcript), `${filename}-sr.srt`)}
            onRetranscribe={onTranscribe}
            processing={processing}
          />
        </div>
        <GlossaryPanel
          project={project}
          onChangeItem={changeItem}
          onRemove={removeItem}
          onSeek={seek}
          onBurn={() => onBurn(videoFile)}
          processing={processing}
        />
      </div>
    </main>
  );
}

function SettingsModal({ value, onSave, onClose }) {
  const [key, setKey] = useState(value);
  return (
    <div className="modal-backdrop" onMouseDown={onClose}>
      <section className="settings-modal" onMouseDown={(event) => event.stopPropagation()}>
        <button className="modal-close" onClick={onClose} aria-label="Закрыть настройки"><X size={20} /></button>
        <div className="modal-icon"><KeyRound size={24} /></div>
        <span className="modal-kicker">ПОДКЛЮЧЕНИЕ</span>
        <h2>Ключ Groq API</h2>
        <p>Он нужен только для распознавания речи. Получите бесплатный ключ в Groq Console, скопируйте его и вставьте ниже.</p>
        <p className="key-guide-copy">Откройте Groq Console по ссылке ниже и войдите в аккаунт. Нажмите Create API Key, после чего скопируйте созданный ключ, который начинается с gsk_, и вставьте его в поле.</p>
        <label>API KEY
          <input type="password" value={key} onChange={(event) => setKey(event.target.value)} placeholder="gsk_••••••••••••••••" autoFocus />
        </label>
        <div className="free-info"><Sparkles size={18} /><p>Бесплатный тариф Groq позволяет выполнить 2 000 запросов в сутки и распознать до двух часов аудио в час или восьми часов в сутки. После сжатия файл должен занимать не более 25 МБ.</p></div>
        <div className="modal-actions">
          <a href="https://console.groq.com/keys" target="_blank" rel="noreferrer">Получить ключ <ChevronRight size={15} /></a>
          <button className="primary-button" onClick={() => onSave(key.trim())}>Сохранить ключ</button>
        </div>
      </section>
    </div>
  );
}

function WelcomeModal({ value, onSave, onClose }) {
  const [key, setKey] = useState(value);
  return (
    <div className="modal-backdrop welcome-backdrop" onMouseDown={onClose}>
      <section className="welcome-modal" onMouseDown={(event) => event.stopPropagation()}>
        <button className="modal-close" onClick={onClose} aria-label="Закрыть инструкцию"><X size={20} /></button>
        <div className="welcome-wolf-wrap">
          <img src="/assets/citavuk-welcome.webp" alt="Читавук приветствует вас" />
        </div>
        <div className="welcome-content">
          <span className="modal-kicker">ПЕРЕД НАЧАЛОМ</span>
          <h2>Познакомьтесь: Читавук</h2>
          <p>Он поможет превратить сербскую речь в субтитры. Для распознавания нужен бесплатный ключ Groq.</p>
          <p className="welcome-guide">Откройте Groq Console по ссылке ниже и войдите в аккаунт. Нажмите Create API Key, скопируйте созданный ключ с началом gsk_ и вставьте его в поле. Ключ сохранится только до закрытия вкладки.</p>
          <div className="welcome-limits">
            <p>Бесплатный тариф включает 2 000 запросов в сутки и позволяет распознать до двух часов аудио в час или до восьми часов в сутки. После сжатия аудиофайл должен занимать не более 25 МБ.</p>
          </div>
          <label className="welcome-key-label">GROQ API KEY
            <input type="password" value={key} onChange={(event) => setKey(event.target.value)} placeholder="gsk_••••••••••••••••" />
          </label>
          <div className="welcome-actions">
            <a href="https://console.groq.com/keys" target="_blank" rel="noreferrer">Получить бесплатный ключ <ChevronRight size={15} /></a>
            <button className="primary-button" onClick={() => onSave(key.trim())}>{key.trim() ? 'Сохранить и начать' : 'Перейти к сайту'}</button>
          </div>
        </div>
      </section>
    </div>
  );
}

function ProcessingBanner({ kind }) {
  if (!kind) return null;
  return (
    <div className="processing-banner">
      <LoaderCircle size={18} className="spin" />
      <div><strong>{kind === 'burn' ? 'Создаём видео с субтитрами' : 'Распознаём сербскую речь'}</strong><span>{kind === 'burn' ? 'Это может занять несколько минут…' : 'Извлекаем звук и расставляем таймкоды…'}</span></div>
    </div>
  );
}

export default function App() {
  const [projects, setProjects] = useState(loadProjects);
  const [activeId, setActiveId] = useState(null);
  const [videoFile, setVideoFile] = useState(null);
  const [videoUrl, setVideoUrl] = useState(null);
  const [apiKey, setApiKey] = useState(() => sessionStorage.getItem('recnik-groq-key') || '');
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [welcomeOpen, setWelcomeOpen] = useState(() => sessionStorage.getItem('recnik-welcome-seen') !== '1');
  const [processing, setProcessing] = useState(null);
  const [toast, setToast] = useState('');
  const activeProject = projects.find((project) => project.id === activeId);

  useEffect(() => {
    localStorage.setItem(PROJECTS_KEY, JSON.stringify(projects));
  }, [projects]);

  useEffect(() => () => {
    if (videoUrl) URL.revokeObjectURL(videoUrl);
  }, [videoUrl]);

  useEffect(() => {
    if (!toast) return undefined;
    const timer = setTimeout(() => setToast(''), 2600);
    return () => clearTimeout(timer);
  }, [toast]);

  const notify = (message) => setToast(message);

  const setCurrentMedia = (file) => {
    setVideoFile(file || null);
    setVideoUrl((previous) => {
      if (previous) URL.revokeObjectURL(previous);
      return file ? URL.createObjectURL(file) : null;
    });
  };

  const createProject = async (file) => {
    if (!file.type.startsWith('video/') && !/\.(mp4|mov|mkv|avi|webm|m4v)$/i.test(file.name)) {
      notify('Выберите видеофайл');
      return;
    }
    if (file.size > 500 * 1024 * 1024) {
      notify('Файл больше 500 МБ');
      return;
    }
    const id = crypto.randomUUID();
    const project = {
      id,
      name: file.name,
      size: file.size,
      type: file.type || 'video',
      createdAt: Date.now(),
      transcript: [],
      glossary: [],
    };
    setProjects((current) => [project, ...current]);
    setActiveId(id);
    setCurrentMedia(file);
    try {
      await saveVideoBlob(id, file);
    } catch {
      notify('Видео открыто, но браузер не смог сохранить его надолго');
    }
  };

  const openDemo = () => {
    const existing = projects.find((project) => project.isDemo);
    if (existing) {
      setActiveId(existing.id);
      setCurrentMedia(null);
      return;
    }
    const project = {
      id: `demo-${Date.now()}`,
      name: 'Прогулка по Дорчолу.mp4',
      size: 0,
      type: 'video/mp4',
      isDemo: true,
      createdAt: Date.now(),
      transcript: DEMO_SEGMENTS,
      glossary: [
        { id: 'g1', word: 'прошетати', translation: 'прогуляться', note: '', time: 4.4 },
        { id: 'g2', word: 'кораку', translation: 'шагу', note: 'на сваком кораку — на каждом шагу', time: 8.8 },
      ],
    };
    setProjects((current) => [project, ...current]);
    setActiveId(project.id);
    setCurrentMedia(null);
  };

  const openProject = async (id) => {
    const project = projects.find((item) => item.id === id);
    if (!project) return;
    setActiveId(id);
    if (project.isDemo) return setCurrentMedia(null);
    try {
      const blob = await getVideoBlob(id);
      setCurrentMedia(blob ? new File([blob], project.name, { type: project.type }) : null);
      if (!blob) notify('Исходное видео не найдено в памяти браузера');
    } catch {
      setCurrentMedia(null);
      notify('Не удалось открыть сохранённое видео');
    }
  };

  const deleteProject = async (id) => {
    setProjects((current) => current.filter((project) => project.id !== id));
    await deleteVideoBlob(id).catch(() => {});
    if (activeId === id) {
      setActiveId(null);
      setCurrentMedia(null);
    }
  };

  const updateProject = (patch) => setProjects((current) => current.map((project) => (
    project.id === activeId ? { ...project, ...patch, updatedAt: Date.now() } : project
  )));

  const transcribe = async () => {
    let file = videoFile;
    if (!file && activeId) {
      const blob = await getVideoBlob(activeId).catch(() => null);
      if (blob) file = new File([blob], activeProject.name, { type: activeProject.type });
    }
    if (!file) return notify('Сначала загрузите исходное видео');

    setProcessing('transcribe');
    try {
      const form = new FormData();
      form.append('video', file, file.name);
      const response = await fetch('/api/transcribe', {
        method: 'POST',
        headers: apiKey ? { 'x-groq-api-key': apiKey } : {},
        body: form,
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) {
        if (response.status === 401 || payload.code === 'MISSING_API_KEY') setSettingsOpen(true);
        throw new Error(payload.error || 'Не удалось распознать речь');
      }
      const transcript = normalizeTranscription(payload);
      if (!transcript.length) throw new Error('Речь не найдена. Проверьте громкость и язык видео.');
      updateProject({ transcript });
      notify(`Готово: ${transcript.length} фрагментов`);
    } catch (error) {
      notify(error.message);
    } finally {
      setProcessing(null);
    }
  };

  const burnVideo = async (currentFile) => {
    let file = currentFile;
    if (!file) {
      const blob = await getVideoBlob(activeId).catch(() => null);
      if (blob) file = new File([blob], activeProject.name, { type: activeProject.type });
    }
    if (!file) return notify('Исходное видео не найдено');

    setProcessing('burn');
    try {
      const form = new FormData();
      form.append('video', file, file.name);
      form.append('subtitles', new Blob([makeSrt(activeProject.transcript)], { type: 'application/x-subrip' }), 'subtitles.srt');
      const response = await fetch('/api/burn', { method: 'POST', body: form });
      if (!response.ok) {
        const payload = await response.json().catch(() => ({}));
        throw new Error(payload.error || 'Не удалось собрать MP4');
      }
      const blob = await response.blob();
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = `${fileStem(activeProject.name)}-sa-titlovima.mp4`;
      anchor.click();
      setTimeout(() => URL.revokeObjectURL(url), 1500);
      notify('MP4 с субтитрами готов');
    } catch (error) {
      notify(error.message);
    } finally {
      setProcessing(null);
    }
  };

  const saveKey = (key) => {
    setApiKey(key);
    if (key) sessionStorage.setItem('recnik-groq-key', key);
    else sessionStorage.removeItem('recnik-groq-key');
    setSettingsOpen(false);
    setWelcomeOpen(false);
    sessionStorage.setItem('recnik-welcome-seen', '1');
    notify(key ? 'Ключ сохранён до закрытия вкладки' : 'Ключ удалён');
  };

  const closeWelcome = () => {
    setWelcomeOpen(false);
    sessionStorage.setItem('recnik-welcome-seen', '1');
  };

  const goHome = () => {
    setActiveId(null);
    setCurrentMedia(null);
  };

  return (
    <div className="app-shell">
      <Header inProject={Boolean(activeProject)} onHome={goHome} onSettings={() => setSettingsOpen(true)} />
      {activeProject ? (
        <Workspace
          project={activeProject}
          videoUrl={videoUrl}
          videoFile={videoFile}
          onBack={goHome}
          onUpdate={updateProject}
          onTranscribe={transcribe}
          onBurn={burnVideo}
          processing={processing}
          notify={notify}
        />
      ) : (
        <Landing projects={projects} onFile={createProject} onDemo={openDemo} onOpen={openProject} onDelete={deleteProject} />
      )}
      <footer>
        <span>ЧИТАВУК-РЕЧНИК, 2026</span>
        <span>Автор сайта: Денис Корнилов (вместе с Gpt Sol 5.6)</span>
        <a href="https://t.me/ivanlindgren" target="_blank" rel="noreferrer">По вопросам: @ivanlindgren</a>
        <button onClick={() => setWelcomeOpen(true)}><CircleHelp size={14} /> Инструкция по ключу</button>
      </footer>
      {settingsOpen && <SettingsModal value={apiKey} onSave={saveKey} onClose={() => setSettingsOpen(false)} />}
      {welcomeOpen && <WelcomeModal value={apiKey} onSave={saveKey} onClose={closeWelcome} />}
      <ProcessingBanner kind={processing} />
      {toast && <div className="toast"><Check size={16} /> {toast}</div>}
    </div>
  );
}

import { useState, useEffect, useRef } from 'react'
import { useNavigate } from 'react-router-dom'
import { PenLine, Trophy, User, X, Pencil, Trash2, ChevronLeft, ChevronRight } from 'lucide-react'
import {
  useDashboardStats,
  useDashboardTrades,
  useDashboardLeaderboard,
  useDashboardProfile,
  useDashboardMyStats,
  useDashboardMyTrades,
  useCreateDashboardTrade,
  useUpdateDashboardTrade,
  useDeleteDashboardTrade,
  useUpdateDashboardNickname,
  useWhoami,
} from '../api/hooks'
import type { DashboardTrade, DashboardTradeWithNickname, CreateDashboardTradeDto } from '../api/types'
import { ApiKeyModal } from '../components/ApiKeyModal'
import './DashboardPage.css'

const PLATFORMS = ['Polymarket', 'DexSport', 'Pinnacle', 'Stake', 'Cloudbet']

function platformClass(name: string): string {
  const l = name.toLowerCase()
  if (l.includes('polymarket')) return 'polymarket'
  if (l.includes('pinnacle')) return 'pinnacle'
  if (l.includes('stake')) return 'stake'
  if (l.includes('cloudbet')) return 'cloudbet'
  if (l.includes('dexsport')) return 'dex'
  return 'other'
}

function formatProfit(val: number | null | undefined): string {
  if (val == null) return '—'
  const sign = val >= 0 ? '+' : ''
  return `${sign}$${Math.abs(val).toFixed(2)}`
}

function formatPct(val: number | null | undefined): string {
  if (val == null) return ''
  const sign = val >= 0 ? '+' : ''
  return `(${sign}${Number(val).toFixed(2)}%)`
}

function formatDate(dateStr: string): string {
  const normalized = dateStr.endsWith('Z') || /[+-]\d{2}:\d{2}$/.test(dateStr) ? dateStr : dateStr + 'Z'
  const d = new Date(normalized)
  return d.toLocaleString('ru-RU', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', timeZone: 'UTC' }) + ' UTC'
}

// ── Add/Edit trade modal ──────────────────────────────────────────────────────

interface TradeFormState {
  bookmaker1: string
  bookmaker2: string
  eventName: string
  sport: string
  outcome1: string
  outcome2: string
  odds1: string
  odds2: string
  stake1: string
  stake2: string
  profit: string
  profitPercent: string
  isPublic: boolean
  winner: string
}

const emptyForm = (): TradeFormState => ({
  bookmaker1: 'Polymarket',
  bookmaker2: 'DexSport',
  eventName: '',
  sport: '',
  outcome1: '',
  outcome2: '',
  odds1: '',
  odds2: '',
  stake1: '',
  stake2: '',
  profit: '',
  profitPercent: '',
  isPublic: true,
  winner: '',
})

function tradeToForm(t: DashboardTrade): TradeFormState {
  return {
    bookmaker1: t.bookmaker1,
    bookmaker2: t.bookmaker2,
    eventName: t.eventName,
    sport: t.sport ?? '',
    outcome1: t.outcome1 ?? '',
    outcome2: t.outcome2 ?? '',
    odds1: String(t.odds1),
    odds2: String(t.odds2),
    stake1: String(t.stake1),
    stake2: String(t.stake2),
    profit: t.profit != null ? String(t.profit) : '',
    profitPercent: t.profitPercent != null ? String(t.profitPercent) : '',
    isPublic: t.isPublic,
    winner: t.winner ?? '',
  }
}

interface PendingTrade {
  bookmaker1?: string
  bookmaker2?: string
  eventName?: string
  sport?: string
  outcome1?: string
  outcome2?: string
  odds1?: string
  odds2?: string
  stake1?: string
  stake2?: string
  profit?: string
  profitPercent?: string
}

interface TradeModalProps {
  initialForm?: TradeFormState
  editId?: string
  onClose: () => void
}

function TradeModal({ initialForm, editId, onClose }: TradeModalProps) {
  const [form, setForm] = useState<TradeFormState>(initialForm ?? emptyForm())
  const createMutation = useCreateDashboardTrade()
  const updateMutation = useUpdateDashboardTrade()

  const set = (key: keyof TradeFormState, val: string | boolean) =>
    setForm((f) => ({ ...f, [key]: val }))

  const isPm1 = form.bookmaker1.toLowerCase() === 'polymarket'
  const isPm2 = form.bookmaker2.toLowerCase() === 'polymarket'

  // Convert input value to decimal odds (Polymarket uses cents 1-99)
  const toDecimalOdds = (val: string, isPm: boolean) => {
    const n = parseFloat(val)
    if (!n || n <= 0) return 0
    return isPm ? 100 / n : n
  }

  // Auto-calculate profit when amounts/odds change
  useEffect(() => {
    const s1 = parseFloat(form.stake1) || 0
    const s2 = parseFloat(form.stake2) || 0
    const o1 = toDecimalOdds(form.odds1, isPm1)
    const o2 = toDecimalOdds(form.odds2, isPm2)
    if (s1 > 0 && s2 > 0 && o1 > 0 && o2 > 0) {
      const total = s1 + s2
      const minProfit = Math.min(s1 * o1, s2 * o2) - total
      const pct = (minProfit / total) * 100
      setForm((f) => ({
        ...f,
        profit: minProfit.toFixed(2),
        profitPercent: pct.toFixed(4),
      }))
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [form.stake1, form.stake2, form.odds1, form.odds2, form.bookmaker1, form.bookmaker2])

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    const dto: CreateDashboardTradeDto = {
      bookmaker1: form.bookmaker1,
      bookmaker2: form.bookmaker2,
      eventName: form.eventName,
      sport: form.sport || undefined,
      outcome1: form.outcome1 || undefined,
      outcome2: form.outcome2 || undefined,
      odds1: toDecimalOdds(form.odds1, isPm1),
      odds2: toDecimalOdds(form.odds2, isPm2),
      stake1: parseFloat(form.stake1) || 0,
      stake2: parseFloat(form.stake2) || 0,
      profit: form.profit ? parseFloat(form.profit) : undefined,
      profitPercent: form.profitPercent ? parseFloat(form.profitPercent) : undefined,
      isPublic: form.isPublic,
      winner: form.winner || undefined,
    }
    if (editId) {
      await updateMutation.mutateAsync({ id: editId, dto })
    } else {
      await createMutation.mutateAsync(dto)
    }
    onClose()
  }

  const isPending = createMutation.isPending || updateMutation.isPending

  return (
    <div className="db-modal-overlay" onClick={onClose}>
      <div className="db-modal" onClick={(e) => e.stopPropagation()}>
        <div className="db-modal-header">
          <span className="db-modal-title">{editId ? 'Редактировать вилку' : 'Добавить вилку'}</span>
          <button className="db-modal-close" onClick={onClose}><X size={18} /></button>
        </div>
        <form className="db-modal-form" onSubmit={handleSubmit}>
          <div className="db-form-row">
            <div className="db-form-group">
              <label>Контора 1</label>
              <select value={form.bookmaker1} onChange={(e) => set('bookmaker1', e.target.value)}>
                {PLATFORMS.map((p) => <option key={p}>{p}</option>)}
              </select>
            </div>
            <div className="db-form-group">
              <label>Контора 2</label>
              <select value={form.bookmaker2} onChange={(e) => set('bookmaker2', e.target.value)}>
                {PLATFORMS.map((p) => <option key={p}>{p}</option>)}
              </select>
            </div>
          </div>

          <div className="db-form-group">
            <label>Матч / событие</label>
            <input
              type="text"
              placeholder="Например: Falcons vs FURIA"
              value={form.eventName}
              onChange={(e) => set('eventName', e.target.value)}
              required
            />
          </div>

          <div className="db-form-row">
            <div className="db-form-group">
              <label>Спорт / категория</label>
              <input type="text" placeholder="esport, tennis..." value={form.sport} onChange={(e) => set('sport', e.target.value)} />
            </div>
            <div className="db-form-group">
              <label>Победитель (контора)</label>
              <select value={form.winner} onChange={(e) => set('winner', e.target.value)}>
                <option value="">Не определён</option>
                <option value={form.bookmaker1}>{form.bookmaker1}</option>
                <option value={form.bookmaker2}>{form.bookmaker2}</option>
              </select>
            </div>
          </div>

          <div className="db-form-row">
            <div className="db-form-group">
              <label>Исход 1 ({form.bookmaker1})</label>
              <input type="text" placeholder="YES / Falcons" value={form.outcome1} onChange={(e) => set('outcome1', e.target.value)} />
            </div>
            <div className="db-form-group">
              <label>Исход 2 ({form.bookmaker2})</label>
              <input type="text" placeholder="NO / FURIA" value={form.outcome2} onChange={(e) => set('outcome2', e.target.value)} />
            </div>
          </div>

          <div className="db-form-row">
            <div className="db-form-group">
              <label>{isPm1 ? 'Цена (¢)' : 'Кэф 1 (×)'}</label>
              <input
                type="number"
                step={isPm1 ? '1' : '0.0001'}
                min="1"
                max={isPm1 ? '99' : undefined}
                placeholder={isPm1 ? '37' : '1.45'}
                value={form.odds1}
                onChange={(e) => set('odds1', e.target.value)}
                required
              />
            </div>
            <div className="db-form-group">
              <label>{isPm2 ? 'Цена (¢)' : 'Кэф 2 (×)'}</label>
              <input
                type="number"
                step={isPm2 ? '1' : '0.0001'}
                min="1"
                max={isPm2 ? '99' : undefined}
                placeholder={isPm2 ? '37' : '2.95'}
                value={form.odds2}
                onChange={(e) => set('odds2', e.target.value)}
                required
              />
            </div>
          </div>

          <div className="db-form-row">
            <div className="db-form-group">
              <label>Ставка 1 ($)</label>
              <input type="number" step="0.01" min="0" placeholder="0.00" value={form.stake1} onChange={(e) => set('stake1', e.target.value)} required />
            </div>
            <div className="db-form-group">
              <label>Ставка 2 ($)</label>
              <input type="number" step="0.01" min="0" placeholder="0.00" value={form.stake2} onChange={(e) => set('stake2', e.target.value)} required />
            </div>
          </div>

          <div className="db-form-row">
            <div className="db-form-group">
              <label>Профит ($)</label>
              <input type="number" step="0.01" placeholder="авто" value={form.profit} onChange={(e) => set('profit', e.target.value)} />
            </div>
            <div className="db-form-group">
              <label>Профит (%)</label>
              <input type="number" step="0.0001" placeholder="авто" value={form.profitPercent} onChange={(e) => set('profitPercent', e.target.value)} />
            </div>
          </div>

          <div className="db-modal-actions">
            <button type="button" className="secondary-button" onClick={onClose}>Отмена</button>
            <button type="submit" className="primary-button" disabled={isPending}>
              {isPending ? 'Сохранение...' : editId ? 'Сохранить' : 'Добавить'}
            </button>
          </div>
        </form>
      </div>
    </div>
  )
}

// ── Nickname edit modal ───────────────────────────────────────────────────────

function NicknameModal({ current, onClose }: { current: string; onClose: () => void }) {
  const [value, setValue] = useState(current)
  const mutation = useUpdateDashboardNickname()

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    await mutation.mutateAsync(value.trim())
    onClose()
  }

  return (
    <div className="db-modal-overlay" onClick={onClose}>
      <div className="db-modal db-modal--sm" onClick={(e) => e.stopPropagation()}>
        <div className="db-modal-header">
          <span className="db-modal-title">Изменить никнейм</span>
          <button className="db-modal-close" onClick={onClose}><X size={18} /></button>
        </div>
        <form className="db-modal-form" onSubmit={handleSubmit}>
          <div className="db-form-group">
            <label>Никнейм</label>
            <input
              type="text"
              maxLength={50}
              value={value}
              onChange={(e) => setValue(e.target.value)}
              required
              autoFocus
            />
          </div>
          {mutation.error && (
            <div className="db-error">
              {mutation.error instanceof Error ? mutation.error.message : 'Произошла ошибка'}
            </div>
          )}
          <div className="db-modal-actions">
            <button type="button" className="secondary-button" onClick={onClose}>Отмена</button>
            <button type="submit" className="primary-button" disabled={mutation.isPending}>
              {mutation.isPending ? 'Сохранение...' : 'Сохранить'}
            </button>
          </div>
        </form>
      </div>
    </div>
  )
}

// ── My Profile tab ────────────────────────────────────────────────────────────

function MyProfileTab() {
  const { data: profileData, isLoading } = useDashboardProfile()
  const { data: myTrades = [], isLoading: tradesLoading } = useDashboardMyTrades()
  const deleteMutation = useDeleteDashboardTrade()
  const [editTrade, setEditTrade] = useState<DashboardTrade | null>(null)
  const [showNicknameModal, setShowNicknameModal] = useState(false)
  const [period, setPeriod] = useState<Period>('all')
  const { data: periodStats } = useDashboardMyStats(period)

  if (isLoading) return <div className="db-loading">Загрузка...</div>
  if (!profileData) return null

  const { profile } = profileData

  return (
    <div className="db-profile">
      <div className="db-period-row">
        {(['1d', '7d', '30d', 'all'] as Period[]).map((p) => (
          <button
            key={p}
            className={`db-period-btn ${period === p ? 'db-period-btn--active' : ''}`}
            onClick={() => setPeriod(p)}
          >
            {PERIOD_LABELS[p]}
          </button>
        ))}
      </div>
      <div className="db-profile-header">
        <div className="db-profile-name">
          <span className="db-nickname-badge">{profile.nickname}</span>
          <button className="db-icon-btn" onClick={() => setShowNicknameModal(true)} title="Изменить никнейм">
            <Pencil size={14} />
          </button>
        </div>
        <div className="db-profile-stats">
          <div className="db-profile-stat">
            <span className="db-profile-stat-label">Всего вилок</span>
            <span className="db-profile-stat-val">{periodStats?.totalTrades ?? '—'}</span>
          </div>
          <div className="db-profile-stat">
            <span className="db-profile-stat-label">Общий профит</span>
            <span className={`db-profile-stat-val ${(periodStats?.totalProfit ?? 0) >= 0 ? 'db-pos' : 'db-neg'}`}>
              {formatProfit(periodStats?.totalProfit)}
            </span>
          </div>
          <div className="db-profile-stat">
            <span className="db-profile-stat-label">Лучший профит</span>
            <span className="db-profile-stat-val db-pos">{formatProfit(periodStats?.bestProfit)}</span>
          </div>
        </div>
      </div>

      {tradesLoading ? (
        <div className="db-loading">Загрузка сделок...</div>
      ) : myTrades.length === 0 ? (
        <div className="db-empty">У вас пока нет добавленных вилок</div>
      ) : (
        <div className="db-table-wrap">
          <table className="db-table">
            <thead>
              <tr>
                <th>Матч</th>
                <th>Площадки</th>
                <th>Ставки</th>
                <th>Профит</th>
                <th>Дата</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {myTrades.map((t) => (
                <tr key={t.id} className={!t.isPublic ? 'db-row-private' : ''}>
                  <td>
                    <div className="db-event-name">{t.eventName}</div>
                    {t.sport && <div className="db-sport-tag">{t.sport}</div>}
                  </td>
                  <td>
                    <div className="db-bookmakers">
                      <span className={`db-bm-tag db-bm-${platformClass(t.bookmaker1)}`}>{t.bookmaker1}</span>
                      <span className={`db-bm-tag db-bm-${platformClass(t.bookmaker2)}`}>{t.bookmaker2}</span>
                    </div>
                  </td>
                  <td>
                    <div className="db-stakes">
                      <span>${Number(t.stake1).toFixed(2)} / ${Number(t.stake2).toFixed(2)}</span>
                      <span className="db-stakes-total">Σ ${(Number(t.stake1) + Number(t.stake2)).toFixed(2)}</span>
                    </div>
                  </td>
                  <td>
                    {t.profit != null && (
                      <span className={`db-profit ${Number(t.profit) >= 0 ? 'db-pos' : 'db-neg'}`}>
                        {formatProfit(Number(t.profit))} {formatPct(t.profitPercent ? Number(t.profitPercent) : null)}
                      </span>
                    )}
                  </td>
                  <td className="db-date">{formatDate(t.createdAt)}</td>
                  <td>
                    <div className="db-row-actions">
                      <button className="db-icon-btn" onClick={() => setEditTrade(t)} title="Редактировать">
                        <Pencil size={13} />
                      </button>
                      <button
                        className="db-icon-btn db-icon-btn--danger"
                        onClick={() => { if (confirm('Удалить вилку?')) deleteMutation.mutate(t.id) }}
                        title="Удалить"
                      >
                        <Trash2 size={13} />
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {editTrade && (
        <TradeModal
          initialForm={tradeToForm(editTrade)}
          editId={editTrade.id}
          onClose={() => setEditTrade(null)}
        />
      )}
      {showNicknameModal && (
        <NicknameModal current={profile.nickname} onClose={() => setShowNicknameModal(false)} />
      )}
    </div>
  )
}

// ── All trades tab ────────────────────────────────────────────────────────────

const PAGE_SIZE = 30

function AllTradesTab() {
  const [offset, setOffset] = useState(0)
  const { data, isLoading } = useDashboardTrades(PAGE_SIZE, offset)

  const trades = data?.trades ?? []
  const total = data?.total ?? 0
  const totalPages = Math.ceil(total / PAGE_SIZE)
  const currentPage = Math.floor(offset / PAGE_SIZE)

  return (
    <div>
      <h2 className="db-section-title">История сделок (все пользователи)</h2>
      {isLoading ? (
        <div className="db-loading">Загрузка...</div>
      ) : trades.length === 0 ? (
        <div className="db-empty">Пока нет публичных сделок</div>
      ) : (
        <>
          <div className="db-table-wrap">
            <table className="db-table">
              <thead>
                <tr>
                  <th>Пользователь</th>
                  <th>Спорт</th>
                  <th>Матч</th>
                  <th>Площадки</th>
                  <th>Ставки</th>
                  <th>Победитель</th>
                  <th>Профит</th>
                  <th>Дата</th>
                </tr>
              </thead>
              <tbody>
                {trades.map((t: DashboardTradeWithNickname) => (
                  <tr key={t.id}>
                    <td>
                      <span className="db-nickname-badge db-nickname-badge--sm">{t.nickname}</span>
                    </td>
                    <td className="db-sport">{t.sport ?? '—'}</td>
                    <td>
                      <div className="db-event-name">{t.eventName}</div>
                    </td>
                    <td>
                      <div className="db-bookmakers">
                        <div className="db-bm-odds-row">
                          <span className={`db-bm-tag db-bm-${platformClass(t.bookmaker1)}`}>{t.bookmaker1}</span>
                          <span className="db-odds">{Number(t.odds1).toFixed(2)}×</span>
                        </div>
                        <div className="db-bm-odds-row">
                          <span className={`db-bm-tag db-bm-${platformClass(t.bookmaker2)}`}>{t.bookmaker2}</span>
                          <span className="db-odds">{Number(t.odds2).toFixed(2)}×</span>
                        </div>
                      </div>
                    </td>
                    <td>
                      <div className="db-stakes">
                        <span>${Number(t.stake1).toFixed(2)} / ${Number(t.stake2).toFixed(2)}</span>
                        <span className="db-stakes-total">Σ ${(Number(t.stake1) + Number(t.stake2)).toFixed(2)}</span>
                      </div>
                    </td>
                    <td>
                      {t.winner ? (
                        <span className={`db-bm-tag db-bm-${platformClass(t.winner)}`}>{t.winner}</span>
                      ) : '—'}
                    </td>
                    <td>
                      {t.profit != null && (
                        <span className={`db-profit ${Number(t.profit) >= 0 ? 'db-pos' : 'db-neg'}`}>
                          {formatProfit(Number(t.profit))} {formatPct(t.profitPercent ? Number(t.profitPercent) : null)}
                        </span>
                      )}
                    </td>
                    <td className="db-date">{formatDate(t.createdAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {totalPages > 1 && (
            <div className="db-pagination">
              <button
                className="db-page-btn"
                disabled={currentPage === 0}
                onClick={() => setOffset(Math.max(0, offset - PAGE_SIZE))}
              >
                <ChevronLeft size={16} />
              </button>
              <span className="db-page-info">{currentPage + 1} / {totalPages}</span>
              <button
                className="db-page-btn"
                disabled={currentPage >= totalPages - 1}
                onClick={() => setOffset(offset + PAGE_SIZE)}
              >
                <ChevronRight size={16} />
              </button>
            </div>
          )}
        </>
      )}
    </div>
  )
}

// ── Leaderboard tab ───────────────────────────────────────────────────────────

function LeaderboardTab() {
  const { data: entries = [], isLoading } = useDashboardLeaderboard()

  return (
    <div>
      <h2 className="db-section-title">Лидерборд</h2>
      {isLoading ? (
        <div className="db-loading">Загрузка...</div>
      ) : entries.length === 0 ? (
        <div className="db-empty">Пока нет данных</div>
      ) : (
        <div className="db-table-wrap">
          <table className="db-table db-table--leaderboard">
            <thead>
              <tr>
                <th>#</th>
                <th>Пользователь</th>
                <th>Вилок</th>
                <th>Общий профит</th>
                <th>Лучший профит</th>
              </tr>
            </thead>
            <tbody>
              {entries.map((e, i) => (
                <tr key={e.userId} className={i < 3 ? `db-top-${i + 1}` : ''}>
                  <td className="db-rank">{i + 1}</td>
                  <td>
                    <span className="db-nickname-badge">{e.nickname}</span>
                  </td>
                  <td>{e.totalTrades}</td>
                  <td>
                    <span className={`db-profit ${e.totalProfit >= 0 ? 'db-pos' : 'db-neg'}`}>
                      {formatProfit(e.totalProfit)}
                    </span>
                  </td>
                  <td>
                    <span className="db-profit db-pos">{formatProfit(e.bestProfit)}</span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}

// ── Main page ─────────────────────────────────────────────────────────────────

type Tab = 'all' | 'leaderboard' | 'profile'
type Period = '1d' | '7d' | '30d' | 'all'

const PERIOD_LABELS: Record<Period, string> = {
  '1d': '1D',
  '7d': '7D',
  '30d': '30D',
  'all': 'ALL',
}

const PERIOD_CARD_LABELS = { profit: 'Общий профит', trades: 'Вилок', best: 'Лучший профит' }

export function DashboardPage() {
  const navigate = useNavigate()
  const [period, setPeriod] = useState<Period>('1d')
  const { data: stats } = useDashboardStats(period)
  const { data: whoami } = useWhoami()
  const { data: profileData } = useDashboardProfile()

  const isLoggedIn = !!localStorage.getItem('apiKey') && !!whoami
  const nickname = profileData?.profile?.nickname

  const [activeTab, setActiveTab] = useState<Tab>('all')
  const [showAddModal, setShowAddModal] = useState(false)
  const [showLoginModal, setShowLoginModal] = useState(false)
  const [pendingForm, setPendingForm] = useState<TradeFormState | undefined>(undefined)
  const pendingFormRef = useRef<TradeFormState | undefined>(undefined)

  // Read pending trade from localStorage on mount (before whoami loads)
  useEffect(() => {
    const raw = localStorage.getItem('pendingDashboardTrade')
    if (!raw) return
    try {
      const pending: PendingTrade = JSON.parse(raw)
      localStorage.removeItem('pendingDashboardTrade')
      const f = emptyForm()
      if (pending.bookmaker1) f.bookmaker1 = pending.bookmaker1
      if (pending.bookmaker2) f.bookmaker2 = pending.bookmaker2
      if (pending.eventName) f.eventName = pending.eventName
      if (pending.sport) f.sport = pending.sport
      if (pending.outcome1) f.outcome1 = pending.outcome1
      if (pending.outcome2) f.outcome2 = pending.outcome2
      if (pending.odds1) f.odds1 = pending.odds1
      if (pending.odds2) f.odds2 = pending.odds2
      if (pending.stake1) f.stake1 = pending.stake1
      if (pending.stake2) f.stake2 = pending.stake2
      if (pending.profit) f.profit = pending.profit
      if (pending.profitPercent) f.profitPercent = pending.profitPercent
      pendingFormRef.current = f
      setPendingForm(f)
    } catch {}
  }, [])

  // Open modal as soon as we know user is logged in and there's a pending form
  useEffect(() => {
    if (isLoggedIn && pendingFormRef.current) {
      setShowAddModal(true)
      pendingFormRef.current = undefined
    }
  }, [isLoggedIn])

  const handleAddClick = () => {
    if (!isLoggedIn) {
      setShowLoginModal(true)
    } else {
      setShowAddModal(true)
    }
  }

  return (
    <div className="db-page">
      {/* Nav */}
      <header className="db-header">
        <div className="db-header-left">
          <div className="db-logo" onClick={() => navigate('/')}>
            <span className="db-logo-icon">A</span>
            <div>
              <div className="db-logo-title">ANDEX DASHBOARD</div>
              <div className="db-logo-sub">Публичный учёт вилок и профита</div>
            </div>
          </div>
        </div>
        <div className="db-header-right">
          <button className="primary-button db-scanner-btn" onClick={() => navigate('/scanner')}>
            Сканер
          </button>
          {isLoggedIn ? (
            <button className="db-profile-btn" onClick={() => setActiveTab('profile')}>
              <User size={14} />
              <span>{nickname ?? 'Профиль'}</span>
            </button>
          ) : (
            <button className="secondary-button" onClick={() => setShowLoginModal(true)}>
              Войти
            </button>
          )}
        </div>
      </header>

      <main className="db-main">
        {/* Period selector + stats cards */}
        {activeTab !== 'profile' && (
          <>
            <div className="db-period-row">
              {(['1d', '7d', '30d', 'all'] as Period[]).map((p) => (
                <button
                  key={p}
                  className={`db-period-btn ${period === p ? 'db-period-btn--active' : ''}`}
                  onClick={() => setPeriod(p)}
                >
                  {PERIOD_LABELS[p]}
                </button>
              ))}
            </div>
            {stats && (
              <div className="db-cards">
                <div className="db-card">
                  <div className="db-card-label">{PERIOD_CARD_LABELS.profit}</div>
                  <div className={`db-card-val ${stats.periodProfit >= 0 ? 'db-pos' : 'db-neg'}`}>
                    {formatProfit(stats.periodProfit)}
                  </div>
                </div>
                <div className="db-card">
                  <div className="db-card-label">{PERIOD_CARD_LABELS.trades}</div>
                  <div className="db-card-val">{stats.periodTrades}</div>
                </div>
                <div className="db-card">
                  <div className="db-card-label">{PERIOD_CARD_LABELS.best}</div>
                  <div className="db-card-val db-pos">{formatProfit(stats.periodBestProfit)}</div>
                </div>
              </div>
            )}
          </>
        )}

        {/* Add trade + login hint */}
        <div className="db-actions-row">
          <button className="primary-button db-add-btn" onClick={handleAddClick}>
            <PenLine size={15} />
            + Добавить сделку
          </button>
          {!isLoggedIn && (
            <div className="db-login-hint">
              Войдите, чтобы вести личный журнал сделок
            </div>
          )}
        </div>

        {/* Tabs */}
        <div className="db-tabs">
          <button
            className={`db-tab ${activeTab === 'all' ? 'db-tab--active' : ''}`}
            onClick={() => setActiveTab('all')}
          >
            Все сделки
          </button>
          <button
            className={`db-tab ${activeTab === 'leaderboard' ? 'db-tab--active' : ''}`}
            onClick={() => setActiveTab('leaderboard')}
          >
            <Trophy size={14} />
            Лидерборд
          </button>
          {isLoggedIn && (
            <button
              className={`db-tab ${activeTab === 'profile' ? 'db-tab--active' : ''}`}
              onClick={() => setActiveTab('profile')}
            >
              Мой профиль
            </button>
          )}
        </div>

        {/* Tab content */}
        <div className="db-tab-content">
          {activeTab === 'all' && <AllTradesTab />}
          {activeTab === 'leaderboard' && <LeaderboardTab />}
          {activeTab === 'profile' && isLoggedIn && <MyProfileTab />}
        </div>
      </main>

      {/* Modals */}
      {showAddModal && (
        <TradeModal
          initialForm={pendingForm}
          onClose={() => { setShowAddModal(false); setPendingForm(undefined) }}
        />
      )}
      {showLoginModal && (
        <ApiKeyModal
          isOpen={showLoginModal}
          onClose={() => setShowLoginModal(false)}
          onSuccess={() => setShowLoginModal(false)}
        />
      )}
    </div>
  )
}

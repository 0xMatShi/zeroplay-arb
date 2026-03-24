import { useState, useEffect, useRef, useCallback } from 'react'
import { useNavigate } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { User, X, Pencil, Trash2, ChevronLeft, ChevronRight } from 'lucide-react'
import { useQueryClient } from '@tanstack/react-query'
import {
  useDashboardAllTrades,
  useDashboardAllMyTrades,
  useDashboardProfile,
  useCreateDashboardTrade,
  useUpdateDashboardTrade,
  useDeleteDashboardTrade,
  useUpdateDashboardNickname,
  useWhoami,
  useActiveSubscription,
} from '../api/hooks'
import { clearAuthCookies } from '../utils/authCookies'
import type { DashboardTrade, DashboardTradeWithNickname, CreateDashboardTradeDto } from '../api/types'
import { ApiKeyModal } from '../components/ApiKeyModal'
import { LanguageSwitcher } from '../components/LanguageSwitcher'
import { SmokeCanvas } from '../components/SmokeCanvas'
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
  const sign = val >= 0 ? '+' : '-'
  return `${sign}${Math.abs(val).toFixed(2)}$`
}

function formatPct(val: number | null | undefined): string {
  if (val == null) return ''
  const sign = val >= 0 ? '+' : '-'
  return `(${sign}${Math.abs(Number(val)).toFixed(2)}%)`
}

function formatDate(dateStr: string): string {
  const normalized = dateStr.endsWith('Z') || /[+-]\d{2}:\d{2}$/.test(dateStr) ? dateStr : dateStr + 'Z'
  const d = new Date(normalized)
  return d.toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', timeZone: 'UTC' }) + ' UTC'
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
  comment: string
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
  comment: '',
})

function tradeToForm(t: DashboardTrade): TradeFormState {
  const isPm1 = t.bookmaker1.toLowerCase() === 'polymarket'
  const isPm2 = t.bookmaker2.toLowerCase() === 'polymarket'
  return {
    bookmaker1: t.bookmaker1,
    bookmaker2: t.bookmaker2,
    eventName: t.eventName,
    sport: t.sport ?? '',
    outcome1: t.outcome1 ?? '',
    outcome2: t.outcome2 ?? '',
    odds1: isPm1 ? String(Math.round(100 / Number(t.odds1))) : String(t.odds1),
    odds2: isPm2 ? String(Math.round(100 / Number(t.odds2))) : String(t.odds2),
    stake1: String(t.stake1),
    stake2: String(t.stake2),
    profit: t.profit != null ? String(t.profit) : '',
    profitPercent: t.profitPercent != null ? String(t.profitPercent) : '',
    isPublic: t.isPublic,
    winner: t.winner ?? '',
    comment: t.comment ?? '',
  }
}

type Period = '1d' | '7d' | '30d' | 'all'

function filterByPeriod<T extends { createdAt: string }>(trades: T[], period: Period, isoDate?: string): T[] {
  if (isoDate) return trades.filter(t => t.createdAt.startsWith(isoDate))
  if (period === 'all') return trades
  const days = period === '1d' ? 1 : period === '7d' ? 7 : 30
  const cutoff = Date.now() - days * 24 * 60 * 60 * 1000
  return trades.filter(t => new Date(t.createdAt).getTime() >= cutoff)
}

function computeGlobalStats(trades: { profit: number | null }[]) {
  const profits = trades.map(t => Number(t.profit) || 0)
  return {
    periodProfit: profits.reduce((a, b) => a + b, 0),
    periodTrades: trades.length,
    periodBestProfit: profits.length > 0 ? Math.max(...profits) : 0,
  }
}

function computeMyStats(trades: { profit: number | null }[]) {
  const profits = trades.map(t => Number(t.profit) || 0)
  return {
    totalProfit: profits.reduce((a, b) => a + b, 0),
    totalTrades: trades.length,
    bestProfit: profits.length > 0 ? Math.max(...profits) : 0,
  }
}

function computeLeaderboard(trades: DashboardTradeWithNickname[]) {
  const map = new Map<string, { userId: string; nickname: string; totalTrades: number; totalProfit: number; bestProfit: number }>()
  for (const t of trades) {
    if (!map.has(t.userId)) {
      map.set(t.userId, { userId: t.userId, nickname: t.nickname, totalTrades: 0, totalProfit: 0, bestProfit: 0 })
    }
    const e = map.get(t.userId)!
    e.totalTrades++
    e.totalProfit += Number(t.profit) || 0
    e.bestProfit = Math.max(e.bestProfit, Number(t.profit) || 0)
  }
  return Array.from(map.values()).sort((a, b) => b.totalProfit - a.totalProfit)
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
  const { t } = useTranslation()
  const [form, setForm] = useState<TradeFormState>(initialForm ?? emptyForm())
  const createMutation = useCreateDashboardTrade()
  const updateMutation = useUpdateDashboardTrade()
  const isFirstRender = useRef(true)

  const set = (key: keyof TradeFormState, val: string | boolean) =>
    setForm((f) => ({ ...f, [key]: val }))

  const isPm1 = form.bookmaker1.toLowerCase() === 'polymarket'
  const isPm2 = form.bookmaker2.toLowerCase() === 'polymarket'

  const toDecimalOdds = (val: string, isPm: boolean) => {
    const n = parseFloat(val)
    if (!n || n <= 0) return 0
    return isPm ? 100 / n : n
  }

  useEffect(() => {
    if (isFirstRender.current) {
      isFirstRender.current = false
      return
    }
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
      comment: form.comment || undefined,
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
    <div className="db-modal-overlay" onClick={(e) => { if (e.target === e.currentTarget) onClose() }}>
      <div className="db-modal" onClick={(e) => e.stopPropagation()}>
        <div className="db-modal-header">
          <span className="db-modal-title">{editId ? t('andexDashboard.editTrade') : t('andexDashboard.addTradeModal')}</span>
          <button className="db-modal-close" onClick={onClose}><X size={18} /></button>
        </div>
        <form className="db-modal-form" onSubmit={handleSubmit}>
          <div className="db-form-row">
            <div className="db-form-group">
              <label>{t('andexDashboard.bookmaker1')}</label>
              <select value={form.bookmaker1} onChange={(e) => set('bookmaker1', e.target.value)}>
                {PLATFORMS.map((p) => <option key={p}>{p}</option>)}
              </select>
            </div>
            <div className="db-form-group">
              <label>{t('andexDashboard.bookmaker2')}</label>
              <select value={form.bookmaker2} onChange={(e) => set('bookmaker2', e.target.value)}>
                {PLATFORMS.map((p) => <option key={p}>{p}</option>)}
              </select>
            </div>
          </div>

          <div className="db-form-group">
            <label>{t('andexDashboard.eventName')}</label>
            <input
              type="text"
              placeholder={t('andexDashboard.eventPlaceholder')}
              value={form.eventName}
              onChange={(e) => set('eventName', e.target.value)}
              required
            />
          </div>

          <div className="db-form-row">
            <div className="db-form-group">
              <label>{t('andexDashboard.sport')}</label>
              <select value={form.sport} onChange={(e) => set('sport', e.target.value)}>
                <option value="">—</option>
                {['Basketball', 'Baseball', 'Tennis', 'Hockey', 'Boxing', 'CS2', 'Valorant', 'Dota 2', 'League of Legends', 'Call of Duty'].map((s) => (
                  <option key={s} value={s.toLowerCase()}>{s}</option>
                ))}
              </select>
            </div>
            <div className="db-form-group">
              <label>{t('andexDashboard.winner')}</label>
              <select value={form.winner} onChange={(e) => set('winner', e.target.value)}>
                <option value="">{t('andexDashboard.winnerNone')}</option>
                <option value={form.bookmaker1}>{form.bookmaker1}</option>
                <option value={form.bookmaker2}>{form.bookmaker2}</option>
              </select>
            </div>
          </div>

          <div className="db-form-row">
            <div className="db-form-group">
              <label>{t('andexDashboard.outcome1')} ({form.bookmaker1})</label>
              <input type="text" placeholder={t('andexDashboard.outcomePlaceholder1')} value={form.outcome1} onChange={(e) => set('outcome1', e.target.value)} />
            </div>
            <div className="db-form-group">
              <label>{t('andexDashboard.outcome2')} ({form.bookmaker2})</label>
              <input type="text" placeholder={t('andexDashboard.outcomePlaceholder2')} value={form.outcome2} onChange={(e) => set('outcome2', e.target.value)} />
            </div>
          </div>

          <div className="db-form-row">
            <div className="db-form-group">
              <label>{isPm1 ? t('andexDashboard.priceCents') : t('andexDashboard.odds', { n: 1 })}</label>
              <input
                type="number"
                step={isPm1 ? '0.01' : '0.0001'}
                min="1"
                max={isPm1 ? '99' : undefined}
                placeholder={isPm1 ? '37' : '1.45'}
                value={form.odds1}
                onChange={(e) => set('odds1', e.target.value)}
                required
              />
            </div>
            <div className="db-form-group">
              <label>{isPm2 ? t('andexDashboard.priceCents') : t('andexDashboard.odds', { n: 2 })}</label>
              <input
                type="number"
                step={isPm2 ? '0.01' : '0.0001'}
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
              <label>{t('andexDashboard.stake1')}</label>
              <input type="number" step="0.01" min="0" placeholder="0.00" value={form.stake1} onChange={(e) => set('stake1', e.target.value)} required />
            </div>
            <div className="db-form-group">
              <label>{t('andexDashboard.stake2')}</label>
              <input type="number" step="0.01" min="0" placeholder="0.00" value={form.stake2} onChange={(e) => set('stake2', e.target.value)} required />
            </div>
          </div>

          <div className="db-form-row">
            <div className="db-form-group">
              <label>{t('andexDashboard.profit')}</label>
              <input type="number" step="0.01" placeholder={t('andexDashboard.profitAuto')} value={form.profit} onChange={(e) => set('profit', e.target.value)} />
            </div>
            <div className="db-form-group">
              <label>{t('andexDashboard.profitPct')}</label>
              <input type="number" step="0.0001" placeholder={t('andexDashboard.profitAuto')} value={form.profitPercent} onChange={(e) => set('profitPercent', e.target.value)} />
            </div>
          </div>

          <div className="db-form-group">
            <label>{t('andexDashboard.comment')}</label>
            <input type="text" placeholder={t('andexDashboard.commentPlaceholder')} value={form.comment} onChange={(e) => set('comment', e.target.value)} />
          </div>

          <div className="db-modal-actions">
            <button type="button" className="secondary-button" onClick={onClose}>{t('andexDashboard.cancel')}</button>
            <button type="submit" className="primary-button" disabled={isPending}>
              {isPending ? t('andexDashboard.saving') : editId ? t('andexDashboard.save') : t('andexDashboard.add')}
            </button>
          </div>
        </form>
      </div>
    </div>
  )
}

// ── Nickname edit modal ───────────────────────────────────────────────────────

function NicknameModal({ current, onClose }: { current: string; onClose: () => void }) {
  const { t } = useTranslation()
  const [value, setValue] = useState(current)
  const mutation = useUpdateDashboardNickname()

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    await mutation.mutateAsync(value.trim())
    onClose()
  }

  return (
    <div className="db-modal-overlay" onClick={(e) => { if (e.target === e.currentTarget) onClose() }}>
      <div className="db-modal db-modal--sm" onClick={(e) => e.stopPropagation()}>
        <div className="db-modal-header">
          <span className="db-modal-title">{t('andexDashboard.editNickname')}</span>
          <button className="db-modal-close" onClick={onClose}><X size={18} /></button>
        </div>
        <form className="db-modal-form" onSubmit={handleSubmit}>
          <div className="db-form-group">
            <label>{t('andexDashboard.nickname')}</label>
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
            <button type="button" className="secondary-button" onClick={onClose}>{t('andexDashboard.cancel')}</button>
            <button type="submit" className="primary-button" disabled={mutation.isPending}>
              {mutation.isPending ? t('andexDashboard.saving') : t('andexDashboard.save')}
            </button>
          </div>
        </form>
      </div>
    </div>
  )
}

// ── My Profile tab ────────────────────────────────────────────────────────────

function MyProfileTab({ trades, isLoading: tradesLoading }: { onEditNickname: () => void; trades: DashboardTrade[]; isLoading?: boolean }) {
  const { t } = useTranslation()
  const deleteMutation = useDeleteDashboardTrade()
  const [editTrade, setEditTrade] = useState<DashboardTrade | null>(null)
  const [sortField, setSortField] = useState<SortField | null>(null)
  const [sortDir, setSortDir] = useState<SortDir>('desc')

  const myTrades = sortField
    ? [...trades].sort((a, b) => {
        let cmp = 0
        if (sortField === 'profit') {
          cmp = (Number(a.profit) ?? 0) - (Number(b.profit) ?? 0)
        } else {
          cmp = new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime()
        }
        return sortDir === 'asc' ? cmp : -cmp
      })
    : trades

  function handleSort(field: SortField) {
    if (sortField === field) {
      setSortDir(d => d === 'asc' ? 'desc' : 'asc')
    } else {
      setSortField(field)
      setSortDir('desc')
    }
  }

  function SortIcon({ field }: { field: SortField }) {
    if (sortField !== field) return <span className="db-sort-icon db-sort-inactive">⇅</span>
    return <span className="db-sort-icon">{sortDir === 'asc' ? '↑' : '↓'}</span>
  }

  return (
    <div className="db-profile">
      <h2 className="db-section-title">{t('andexDashboard.myTradesTitle')}</h2>

      {tradesLoading ? (
        <div className="db-loading">{t('andexDashboard.loadingTrades')}</div>
      ) : myTrades.length === 0 ? (
        <div className="db-empty">{t('andexDashboard.noMyTrades')}</div>
      ) : (
        <div className="db-table-wrap">
          <table className="db-table">
            <thead>
              <tr>
                <th>{t('andexDashboard.colMatch')}</th>
                <th>{t('andexDashboard.colPlatforms')}</th>
                <th>{t('andexDashboard.colStakes')}</th>
                <th className="db-th-sortable" onClick={() => handleSort('profit')}>
                  {t('andexDashboard.colProfit')} <SortIcon field="profit" />
                </th>
                <th className="db-th-sortable" onClick={() => handleSort('date')}>
                  {t('andexDashboard.colDate')} <SortIcon field="date" />
                </th>
                <th>{t('andexDashboard.colComment')}</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {myTrades.map((trade) => (
                <tr key={trade.id} className={!trade.isPublic ? 'db-row-private' : ''}>
                  <td>
                    <div className="db-event-name">{trade.eventName}</div>
                    {trade.sport && <div className="db-sport-tag">{trade.sport}</div>}
                  </td>
                  <td>
                    <div className="db-bookmakers">
                      <span className={`db-bm-tag db-bm-${platformClass(trade.bookmaker1)}`}>{trade.bookmaker1}</span>
                      <span className={`db-bm-tag db-bm-${platformClass(trade.bookmaker2)}`}>{trade.bookmaker2}</span>
                    </div>
                  </td>
                  <td>
                    <div className="db-stakes">
                      <span>{(Number(trade.stake1) + Number(trade.stake2)).toFixed(2)}$</span>
                    </div>
                  </td>
                  <td>
                    {trade.profit != null && (
                      <span className={`db-profit ${Number(trade.profit) >= 0 ? 'db-pos' : 'db-neg'}`}>
                        {formatProfit(Number(trade.profit))} {formatPct(trade.profitPercent ? (Number(trade.profit) < 0 ? -Math.abs(Number(trade.profitPercent)) : Math.abs(Number(trade.profitPercent))) : null)}
                      </span>
                    )}
                  </td>
                  <td className="db-date">{formatDate(trade.createdAt)}</td>
                  <td className="db-comment">{trade.comment ?? ''}</td>
                  <td>
                    <div className="db-row-actions">
                      <button className="db-icon-btn" onClick={() => setEditTrade(trade)} title={t('andexDashboard.editTooltip')}>
                        <Pencil size={13} />
                      </button>
                      <button
                        className="db-icon-btn db-icon-btn--danger"
                        onClick={() => { if (confirm(t('andexDashboard.deleteConfirm'))) deleteMutation.mutate(trade.id) }}
                        title={t('andexDashboard.deleteTooltip')}
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
    </div>
  )
}

// ── All trades tab ────────────────────────────────────────────────────────────

const PAGE_SIZE = 30

type SortField = 'profit' | 'date'
type SortDir = 'asc' | 'desc'

function AllTradesTab({ trades: allTrades, isLoading }: { trades: DashboardTradeWithNickname[]; isLoading: boolean }) {
  const { t } = useTranslation()
  const [offset, setOffset] = useState(0)
  const [sortField, setSortField] = useState<SortField | null>(null)
  const [sortDir, setSortDir] = useState<SortDir>('desc')

  const sorted = sortField
    ? [...allTrades].sort((a, b) => {
        let cmp = 0
        if (sortField === 'profit') {
          cmp = (Number(a.profit) ?? 0) - (Number(b.profit) ?? 0)
        } else {
          cmp = new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime()
        }
        return sortDir === 'asc' ? cmp : -cmp
      })
    : allTrades

  const total = sorted.length
  const totalPages = Math.ceil(total / PAGE_SIZE)
  const currentPage = Math.floor(offset / PAGE_SIZE)
  const trades = sorted.slice(offset, offset + PAGE_SIZE)

  function handleSort(field: SortField) {
    if (sortField === field) {
      setSortDir(d => d === 'asc' ? 'desc' : 'asc')
    } else {
      setSortField(field)
      setSortDir('desc')
    }
  }

  function SortIcon({ field }: { field: SortField }) {
    if (sortField !== field) return <span className="db-sort-icon db-sort-inactive">⇅</span>
    return <span className="db-sort-icon">{sortDir === 'asc' ? '↑' : '↓'}</span>
  }

  return (
    <div>
      <h2 className="db-section-title">{t('andexDashboard.allTradesTitle')}</h2>
      {isLoading ? (
        <div className="db-loading">{t('andexDashboard.loading')}</div>
      ) : trades.length === 0 ? (
        <div className="db-empty">{t('andexDashboard.noPublicTrades')}</div>
      ) : (
        <>
          <div className="db-table-wrap">
            <table className="db-table">
              <thead>
                <tr>
                  <th>{t('andexDashboard.colUser')}</th>
                  <th>{t('andexDashboard.colMatch')}</th>
                  <th>{t('andexDashboard.colPlatforms')}</th>
                  <th>{t('andexDashboard.colStakes')}</th>
                  <th>{t('andexDashboard.colWinner')}</th>
                  <th className="db-th-sortable" onClick={() => handleSort('profit')}>
                    {t('andexDashboard.colProfit')} <SortIcon field="profit" />
                  </th>
                  <th className="db-th-sortable" onClick={() => handleSort('date')}>
                    {t('andexDashboard.colDate')} <SortIcon field="date" />
                  </th>
                </tr>
              </thead>
              <tbody>
                {trades.map((trade: DashboardTradeWithNickname) => (
                  <tr key={trade.id}>
                    <td>
                      <span className="db-nickname-badge db-nickname-badge--sm">{trade.nickname}</span>
                    </td>
                    <td>
                      <div className="db-event-name">{trade.eventName}</div>
                      {trade.sport && <div className="db-sport-tag">{trade.sport}</div>}
                    </td>
                    <td>
                      <div className="db-bookmakers">
                        <div className="db-bm-odds-row">
                          <span className={`db-bm-tag db-bm-${platformClass(trade.bookmaker1)}`}>{trade.bookmaker1}</span>
                          {trade.bookmaker1.toLowerCase() === 'polymarket'
                            ? <span className="db-odds">{(100 / Number(trade.odds1)).toFixed(1)}¢</span>
                            : <span className="db-odds">{Number(trade.odds1).toFixed(2)}×</span>}
                        </div>
                        <div className="db-bm-odds-row">
                          <span className={`db-bm-tag db-bm-${platformClass(trade.bookmaker2)}`}>{trade.bookmaker2}</span>
                          {trade.bookmaker2.toLowerCase() === 'polymarket'
                            ? <span className="db-odds">{(100 / Number(trade.odds2)).toFixed(1)}¢</span>
                            : <span className="db-odds">{Number(trade.odds2).toFixed(2)}×</span>}
                        </div>
                      </div>
                    </td>
                    <td>
                      <div className="db-stakes">
                        <span>{(Number(trade.stake1) + Number(trade.stake2)).toFixed(2)}$</span>
                      </div>
                    </td>
                    <td>
                      {trade.winner ? (
                        <span className={`db-bm-tag db-bm-${platformClass(trade.winner)}`}>{trade.winner}</span>
                      ) : t('andexDashboard.noValue')}
                    </td>
                    <td>
                      {trade.profit != null && (
                        <span className={`db-profit ${Number(trade.profit) >= 0 ? 'db-pos' : 'db-neg'}`}>
                          {formatProfit(Number(trade.profit))} {formatPct(trade.profitPercent ? (Number(trade.profit) < 0 ? -Math.abs(Number(trade.profitPercent)) : Math.abs(Number(trade.profitPercent))) : null)}
                        </span>
                      )}
                    </td>
                    <td className="db-date">{formatDate(trade.createdAt)}</td>
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

function LeaderboardTab({ trades, isLoading }: { trades: DashboardTradeWithNickname[]; isLoading: boolean }) {
  const { t } = useTranslation()
  const entries = computeLeaderboard(trades)

  return (
    <div>
      <h2 className="db-section-title">{t('andexDashboard.leaderboardTitle')}</h2>
      {isLoading ? (
        <div className="db-loading">{t('andexDashboard.loading')}</div>
      ) : entries.length === 0 ? (
        <div className="db-empty">{t('andexDashboard.noData')}</div>
      ) : (
        <div className="db-table-wrap">
          <table className="db-table db-table--leaderboard">
            <thead>
              <tr>
                <th>{t('andexDashboard.colRank')}</th>
                <th>{t('andexDashboard.colUser')}</th>
                <th>{t('andexDashboard.colForks')}</th>
                <th>{t('andexDashboard.colTotalProfit')}</th>
                <th>{t('andexDashboard.colBestProfit')}</th>
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

const PERIOD_CARD_LABELS_KEY = { profit: 'andexDashboard.statTotalProfit', trades: 'andexDashboard.statForks', best: 'andexDashboard.statBestProfit' }

export function DashboardPage() {
  const { t } = useTranslation()
  const navigate = useNavigate()
  const [period, setPeriod] = useState<Period>('1d')
  const [customDate, setCustomDate] = useState('')
  const [confirmedDate, setConfirmedDate] = useState('')
  const [showDatePicker, setShowDatePicker] = useState(false)

  function parseDayMonth(val: string): string | undefined {
    const m = val.match(/^(\d{1,2})\.(\d{2})$/)
    if (!m) return undefined
    const year = new Date().getFullYear()
    const month = m[2].padStart(2, '0')
    const day = m[1].padStart(2, '0')
    return `${year}-${month}-${day}`
  }

  const isoDate = parseDayMonth(confirmedDate)
  const isCustomRange = !!isoDate

  const { data: allTradesData, isLoading: allTradesLoading } = useDashboardAllTrades()
  const { data: allMyTradesRaw = [], isLoading: myTradesLoading } = useDashboardAllMyTrades()
  const allPublicTrades = allTradesData?.trades ?? []
  const filteredPublicTrades = filterByPeriod(allPublicTrades, period, isoDate)
  const filteredMyTrades = filterByPeriod(allMyTradesRaw, period, isoDate)
  const stats = computeGlobalStats(filteredPublicTrades)
  const myStats = computeMyStats(filteredMyTrades)

  const { data: whoami } = useWhoami()
  const { data: profileData } = useDashboardProfile()

  const isLoggedIn = !!localStorage.getItem('apiKey') && !!whoami
  const nickname = profileData?.profile?.nickname

  const [activeTab, setActiveTab] = useState<Tab>('all')
  const tabsRef = useRef<HTMLDivElement>(null)
  const [indicatorStyle, setIndicatorStyle] = useState({ left: 0, width: 0 })

  useEffect(() => {
    const container = tabsRef.current
    if (!container) return
    const active = container.querySelector<HTMLElement>('.db-tab--active')
    if (!active) return
    const containerRect = container.getBoundingClientRect()
    const activeRect = active.getBoundingClientRect()
    setIndicatorStyle({ left: activeRect.left - containerRect.left, width: activeRect.width })
  }, [activeTab])

  const [showAddModal, setShowAddModal] = useState(false)
  const [showLoginModal, setShowLoginModal] = useState(false)
  const [showNicknameModal, setShowNicknameModal] = useState(false)
  const [pendingForm, setPendingForm] = useState<TradeFormState | undefined>(undefined)
  const pendingFormRef = useRef<TradeFormState | undefined>(undefined)
  const [isProfileOpen, setIsProfileOpen] = useState(false)
  const queryClient = useQueryClient()

  const { data: activeSub } = useActiveSubscription()

  const calcSubInfo = useCallback(() => {
    if (!activeSub) return null
    if (!activeSub.expiresAt) return { label: null, pct: 100 }
    const now = Date.now()
    const expires = new Date(activeSub.expiresAt).getTime()
    const starts = new Date(activeSub.startsAt).getTime()
    const totalMs = expires - starts
    const remainingMs = Math.max(0, expires - now)
    const pct = totalMs > 0 ? Math.max(0, Math.min(100, (remainingMs / totalMs) * 100)) : 0
    const totalMins = Math.floor(remainingMs / 60_000)
    const days = Math.floor(totalMins / 1440)
    const hours = Math.floor((totalMins % 1440) / 60)
    const mins = totalMins % 60
    const parts: string[] = []
    if (days > 0) parts.push(`${days}d`)
    if (hours > 0) parts.push(`${hours}h`)
    if (mins > 0 || parts.length === 0) parts.push(`${mins}m`)
    return { label: parts.join(' '), pct }
  }, [activeSub])

  const [subDaysInfo, setSubDaysInfo] = useState(() => calcSubInfo())
  useEffect(() => {
    setSubDaysInfo(calcSubInfo())
    if (!activeSub?.expiresAt) return
    const id = setInterval(() => setSubDaysInfo(calcSubInfo()), 60_000)
    return () => clearInterval(id)
  }, [activeSub, calcSubInfo])

  const PERIOD_LABELS: Record<Period, string> = {
    '1d': t('andexDashboard.period1d'),
    '7d': t('andexDashboard.period7d'),
    '30d': t('andexDashboard.period30d'),
    'all': t('andexDashboard.periodAll'),
  }

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
      if (pending.sport) f.sport = pending.sport.toLowerCase()
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
      <SmokeCanvas />
      {/* Nav */}
      <header className="db-header">
        <div className="db-header-inner">
        <div className="db-header-left">
          <div className="db-logo" onClick={() => navigate('/')}>
            <div className="db-logo-title">{t('andexDashboard.title')}</div>
          </div>
        </div>
        <div className="db-header-right">
          <LanguageSwitcher />
          {!isLoggedIn ? (
            <button className="header-button-login" onClick={() => setShowLoginModal(true)}>
              {t('andexDashboard.login')}
            </button>
          ) : (
            <button
              type="button"
              className="gradient-profile-btn"
              onClick={() => setIsProfileOpen(true)}
            >
              {t('andexDashboard.tabProfile')}
            </button>
          )}
        </div>
        </div>
      </header>

      <main className="db-main">
        {/* Period selector + stats cards */}
        <div className="db-period-row">
          {(['1d', '7d', '30d', 'all'] as Period[]).map((p) => (
            <button
              key={p}
              className={`db-period-btn ${period === p && !isCustomRange && !showDatePicker ? 'db-period-btn--active' : ''}`}
              onClick={() => { setPeriod(p); setCustomDate(''); setShowDatePicker(false) }}
            >
              {PERIOD_LABELS[p]}
            </button>
          ))}
          <div className="db-date-btn-wrap">
            <button
              className={`db-period-btn ${isCustomRange || showDatePicker ? 'db-period-btn--active' : ''}`}
              onClick={() => { setShowDatePicker(v => !v); setCustomDate(confirmedDate) }}
            >
              {t('andexDashboard.customDate')}{confirmedDate ? ` ${confirmedDate}` : ''}
            </button>
            {isCustomRange && (
              <button className="db-date-clear" onClick={() => { setConfirmedDate(''); setCustomDate(''); setShowDatePicker(false) }}>✕</button>
            )}
          </div>
          {showDatePicker && (
            <div className="db-datepicker">
              <input
                type="text"
                className="db-date-input"
                placeholder={t('andexDashboard.datePlaceholder')}
                maxLength={5}
                value={customDate}
                autoFocus
                onChange={e => setCustomDate(e.target.value)}
                onKeyDown={e => { if (e.key === 'Enter' && parseDayMonth(customDate)) { setConfirmedDate(customDate); setShowDatePicker(false) } }}
              />
              {parseDayMonth(customDate) && (
                <button className="db-date-confirm" onClick={() => { setConfirmedDate(customDate); setShowDatePicker(false) }}>✓</button>
              )}
              {customDate && (
                <button className="db-date-clear" onClick={() => { setCustomDate(''); setConfirmedDate(''); }}>✕</button>
              )}
            </div>
          )}
        </div>
        {activeTab === 'profile' ? (
          <div className="db-cards">
            <div className="db-card">
              <div className="db-card-label">{t('andexDashboard.myTotalProfit')}</div>
              <div className={`db-card-val ${(myStats?.totalProfit ?? 0) >= 0 ? 'db-pos' : 'db-neg'}`}>
                {formatProfit(myStats?.totalProfit)}
              </div>
            </div>
            <div className="db-card">
              <div className="db-card-label">{t('andexDashboard.myTotalTrades')}</div>
              <div className="db-card-val">{myStats?.totalTrades ?? '—'}</div>
            </div>
            <div className="db-card">
              <div className="db-card-label">{t('andexDashboard.myBestProfit')}</div>
              <div className="db-card-val db-pos">{formatProfit(myStats?.bestProfit)}</div>
            </div>
          </div>
        ) : (
          <div className="db-cards">
            <div className="db-card">
              <div className="db-card-label">{t(PERIOD_CARD_LABELS_KEY.profit)}</div>
              <div className={`db-card-val ${stats.periodProfit >= 0 ? 'db-pos' : 'db-neg'}`}>
                {formatProfit(stats.periodProfit)}
              </div>
            </div>
            <div className="db-card">
              <div className="db-card-label">{t(PERIOD_CARD_LABELS_KEY.trades)}</div>
              <div className="db-card-val">{stats.periodTrades}</div>
            </div>
            <div className="db-card">
              <div className="db-card-label">{t(PERIOD_CARD_LABELS_KEY.best)}</div>
              <div className="db-card-val db-pos">{formatProfit(stats.periodBestProfit)}</div>
            </div>
          </div>
        )}

        {/* Tabs */}
        <div className="db-tabs" ref={tabsRef}>
          <button
            className={`db-tab ${activeTab === 'all' ? 'db-tab--active' : ''}`}
            onClick={() => setActiveTab('all')}
          >
            {t('andexDashboard.tabAll')}
          </button>
          <button
            className={`db-tab ${activeTab === 'leaderboard' ? 'db-tab--active' : ''}`}
            onClick={() => setActiveTab('leaderboard')}
          >
            {t('andexDashboard.tabLeaderboard')}
          </button>
          {isLoggedIn && (
            <>
              <button
                className={`db-tab ${activeTab === 'profile' ? 'db-tab--active' : ''}`}
                onClick={() => setActiveTab('profile')}
              >
                {t('andexDashboard.tabProfile')}
              </button>
              {activeTab === 'profile' && (
                <button className="db-tab-add-btn" onClick={handleAddClick}>
                  {t('andexDashboard.addTrade')}
                </button>
              )}
            </>
          )}
          <div
            className="db-tab-indicator"
            style={{ left: indicatorStyle.left, width: indicatorStyle.width }}
          />
        </div>

        {/* Tab content */}
        <div className="db-tab-content">
          {activeTab === 'all' && <AllTradesTab key={`${period}-${isoDate ?? ''}`} trades={filteredPublicTrades} isLoading={allTradesLoading} />}
          {activeTab === 'leaderboard' && <LeaderboardTab trades={filteredPublicTrades} isLoading={allTradesLoading} />}
          {activeTab === 'profile' && isLoggedIn && <MyProfileTab onEditNickname={() => setShowNicknameModal(true)} trades={filteredMyTrades} isLoading={myTradesLoading} />}
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
      {showNicknameModal && nickname != null && (
        <NicknameModal current={nickname} onClose={() => setShowNicknameModal(false)} />
      )}

      {/* Profile sliding panel */}
      <div
        className={`profile-overlay ${isProfileOpen ? 'profile-overlay--open' : ''}`}
        onClick={() => setIsProfileOpen(false)}
      />
      <div className={`profile-panel ${isProfileOpen ? 'profile-panel--open' : ''}`}>
        <SmokeCanvas />
        <div className="profile-panel-inner">
          <div className="profile-panel-header">
            <div className="profile-panel-avatar">
              <User size={32} />
            </div>
            {nickname && (
              <div className="profile-panel-nick-wrap">
                <span className="profile-panel-nickname">{nickname}</span>
                <button
                  className="db-icon-btn db-edit-nick-btn"
                  onClick={() => { setIsProfileOpen(false); setShowNicknameModal(true) }}
                  title={t('andexDashboard.editNickname')}
                >
                  <Pencil size={13} />
                </button>
              </div>
            )}
          </div>
          <div className="profile-panel-section">
            <div className="profile-panel-label">{t('scanner.currentPlan') || 'Подписка'}</div>
            {subDaysInfo ? (
              <>
                <div className="profile-sub-days">
                  {subDaysInfo.label === null
                    ? (t('scanner.lifetimeSub') || 'Навсегда')
                    : subDaysInfo.label}
                </div>
                <div className="profile-hp-bar">
                  <div className="profile-hp-fill" style={{ width: `${subDaysInfo.pct}%` }} />
                </div>
              </>
            ) : (
              <div className="profile-sub-days profile-sub-days--none">
                {t('scanner.noActiveSub') || 'Нет подписки'}
              </div>
            )}
          </div>
          <div className="profile-panel-actions">
            <button
              className="profile-action-btn"
              onClick={() => { setIsProfileOpen(false); navigate('/scanner') }}
            >
              {t('andexDashboard.scanner')}
            </button>
            <a
              href={`https://docs.subline.space?key=${localStorage.getItem('apiKey') ?? ''}`}
              target="_blank"
              rel="noopener noreferrer"
              className="profile-action-btn"
            >
              {t('scanner.learnGuide')}
            </a>
            <a
              href={import.meta.env.VITE_TELEGRAM_BOT_URL as string}
              target="_blank"
              rel="noopener noreferrer"
              className="profile-action-btn"
            >
              {t('scanner.renewSub')}
            </a>
            <a
              href={import.meta.env.VITE_TELEGRAM_SUPPORT_URL as string}
              target="_blank"
              rel="noopener noreferrer"
              className="profile-action-btn"
            >
              {t('scanner.askQuestion')}
            </a>
            <button
              className="profile-action-btn profile-action-btn--logout"
              onClick={() => {
                localStorage.removeItem('apiKey')
                localStorage.removeItem('sessionToken')
                clearAuthCookies()
                queryClient.clear()
                navigate('/')
              }}
            >
              {t('scanner.logout')}
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}

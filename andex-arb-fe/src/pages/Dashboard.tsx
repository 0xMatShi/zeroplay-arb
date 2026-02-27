import { useEffect, useState, useMemo } from 'react'
import { useNavigate, useLocation } from 'react-router-dom'
import { useQueryClient } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { useWriteContract, useWaitForTransactionReceipt } from 'wagmi'
import { parseUnits } from 'viem'
import { QRCodeSVG } from 'qrcode.react'
import { useWhoami, usePlans, useCreatePaymentRequest, useMyPaymentRequests, useCancelPaymentRequest, useActiveSubscription, queryKeys } from '../api'
import { LanguageSwitcher } from '../components/LanguageSwitcher'
import { formatUsd } from '../utils/formatPrice'
import { CHAIN_ICONS, getTokenIcon } from '../utils/chainIcons'
import type { PaymentRequestResponseDto, ChainId, PlanDto, SupportedToken } from '../api/types'

const erc20Abi = [
  {
    name: 'transfer',
    type: 'function',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'recipient', type: 'address' },
      { name: 'amount', type: 'uint256' },
    ],
    outputs: [{ name: '', type: 'bool' }],
  },
] as const

const CHAIN_OPTIONS: { id: ChainId; name: string }[] = [
  { id: 'ethereum', name: 'Ethereum' },
  { id: 'bsc', name: 'BNB Chain' },
  { id: 'arbitrum', name: 'Arbitrum' },
  { id: 'base', name: 'Base' },
]

const getChainName = (chainId: string) =>
  CHAIN_OPTIONS.find(c => c.id === chainId)?.name ?? chainId

const PLAN_FEATURES: Record<string, string[]> = {
  FREE: ['features.limitedScanner', 'features.delayedData', 'features.basicAlerts'],
  PRO: ['features.realtimeScanner', 'features.telegramAlerts', 'features.allPlatforms', 'features.orderbookDepth'],
  ENTERPRISE: ['features.everythingInPro', 'features.apiAccess', 'features.priorityAlerts', 'features.dedicatedSupport'],
}

function getPlanFeatures(plan: PlanDto): string[] {
  const name = plan.name.toUpperCase()
  return PLAN_FEATURES[name] ?? PLAN_FEATURES['PRO']
}

const isPro = (plan: PlanDto) => plan.name.toUpperCase() === 'PRO'

export function Dashboard() {
  const { t } = useTranslation()
  const navigate = useNavigate()
  const location = useLocation()
  const queryClient = useQueryClient()
  const { data: user, isLoading: isLoadingUser } = useWhoami()
  const { data: plans } = usePlans()
  const [hasPending, setHasPending] = useState(false)
  const { data: paymentRequests } = useMyPaymentRequests(hasPending)
  const { data: activeSubscription } = useActiveSubscription()
  const createPaymentRequest = useCreatePaymentRequest()
  const cancelPaymentRequest = useCancelPaymentRequest()
  
  const [selectedPlanId, setSelectedPlanId] = useState<string | null>(
    location.state?.planId || null
  )
  const [selectedChainId, setSelectedChainId] = useState<ChainId>('ethereum')
  const [isCreating, setIsCreating] = useState(false)
  const [copiedField, setCopiedField] = useState<string | null>(null)
  const [countdown, setCountdown] = useState('')
  const [selectedToken, setSelectedToken] = useState<SupportedToken | null>(null)

  const { data: txHash, isPending: isTxPending, writeContract } = useWriteContract()
  const { isLoading: isConfirming, isSuccess: isConfirmed } = useWaitForTransactionReceipt({ hash: txHash })

  useEffect(() => {
    const apiKey = localStorage.getItem('apiKey')
    if (!isLoadingUser && !user && !apiKey) {
      navigate('/')
    }
  }, [user, isLoadingUser, navigate])

  const pendingRequest = useMemo(() => {
    if (!paymentRequests || !plans) return null
    
    const pending = paymentRequests.find((request: PaymentRequestResponseDto) => {
      return request.status.toLowerCase() === 'pending'
    })

    if (!pending) return null

    const plan = plans.find(p => p.id === pending.planId)
    return {
      request: pending,
      plan,
      expiresAt: new Date(pending.expiresAt),
    }
  }, [paymentRequests, plans])

  useEffect(() => {
    const isPending = !!pendingRequest
    setHasPending(isPending)

    if (!isPending && hasPending) {
      queryClient.invalidateQueries({ queryKey: queryKeys.activeSubscription })
      queryClient.invalidateQueries({ queryKey: queryKeys.subscriptionStatus })
    }
  }, [pendingRequest, hasPending, queryClient])

  useEffect(() => {
    if (!pendingRequest) { setCountdown(''); return }

    const tick = () => {
      const diff = pendingRequest.expiresAt.getTime() - Date.now()
      if (diff <= 0) { setCountdown('00:00'); return }
      const h = Math.floor(diff / 3_600_000)
      const m = Math.floor((diff % 3_600_000) / 60_000)
      const s = Math.floor((diff % 60_000) / 1_000)
      setCountdown(h > 0 ? `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}` : `${m}:${String(s).padStart(2, '0')}`)
    }

    tick()
    const id = setInterval(tick, 1_000)
    return () => clearInterval(id)
  }, [pendingRequest])

  useEffect(() => {
    if (pendingRequest?.request.supportedTokens.length && !selectedToken) {
      setSelectedToken(pendingRequest.request.supportedTokens[0])
    }
  }, [pendingRequest, selectedToken])

  const handlePayment = () => {
    if (!selectedToken || !pendingRequest) return

    writeContract({
      address: selectedToken.address as `0x${string}`,
      abi: erc20Abi,
      functionName: 'transfer',
      args: [
        pendingRequest.request.walletAddress as `0x${string}`,
        parseUnits(pendingRequest.request.amount, 18),
      ],
    })
  }

  const [txPolling, setTxPolling] = useState(false)

  useEffect(() => {
    if (!isConfirmed) return
    setTxPolling(true)

    queryClient.invalidateQueries({ queryKey: queryKeys.paymentRequests })
    queryClient.invalidateQueries({ queryKey: queryKeys.subscriptionStatus })
    queryClient.invalidateQueries({ queryKey: queryKeys.activeSubscription })

    const interval = setInterval(() => {
      queryClient.invalidateQueries({ queryKey: queryKeys.paymentRequests })
      queryClient.invalidateQueries({ queryKey: queryKeys.subscriptionStatus })
      queryClient.invalidateQueries({ queryKey: queryKeys.activeSubscription })
    }, 4_000)

    return () => clearInterval(interval)
  }, [isConfirmed, queryClient])

  useEffect(() => {
    if (txPolling && activeSubscription) {
      setTxPolling(false)
    }
  }, [txPolling, activeSubscription])

  const handleCreatePaymentRequest = async (planId: string) => {
    try {
      setIsCreating(true)
      await createPaymentRequest.mutateAsync({ planId, chainId: selectedChainId })
      setSelectedPlanId(null)
      alert('Payment request created successfully!')
    } catch (error) {
      console.error('Failed to create payment request:', error)
      alert('Failed to create payment request. Please try again.')
    } finally {
      setIsCreating(false)
    }
  }

  const handleCopy = (text: string, fieldId: string) => {
    navigator.clipboard.writeText(text)
    setCopiedField(fieldId)
    setTimeout(() => setCopiedField(null), 2000)
  }

  const handleCancel = async (requestId: string) => {
    if (!confirm('Are you sure you want to cancel this payment request?')) {
      return
    }

    try {
      await cancelPaymentRequest.mutateAsync(requestId)
      alert('Payment request cancelled successfully')
    } catch (error) {
      console.error('Failed to cancel payment request:', error)
      alert('Failed to cancel payment request. Please try again.')
    }
  }

  if (isLoadingUser) {
    return (
      <div className="dashboard">
        <div className="container">
          <div className="loading">{t('dashboard.loading')}</div>
        </div>
      </div>
    )
  }

  if (!user) {
    return null // Will redirect
  }

  const selectedPlan = plans?.find(p => p.id === selectedPlanId)

  const shortenAddress = (addr: string) => {
    return `${addr.slice(0, 6)}...${addr.slice(-4)}`
  }

  const calculateTimeRemaining = (expiresAt: Date) => {
    const now = new Date()
    const diff = expiresAt.getTime() - now.getTime()
    
    if (diff <= 0) return { days: 0, hours: 0, percent: 0 }
    
    const days = Math.floor(diff / (1000 * 60 * 60 * 24))
    const hours = Math.floor((diff % (1000 * 60 * 60 * 24)) / (1000 * 60 * 60))
    
    return { days, hours }
  }

  const calculateProgress = (startDate: Date, expiresAt: Date) => {
    const now = new Date()
    const total = expiresAt.getTime() - startDate.getTime()
    const elapsed = now.getTime() - startDate.getTime()
    const percent = Math.max(0, Math.min(100, (elapsed / total) * 100))
    return percent
  }

  return (
    <div className="dashboard">
      <div className="dashboard-container">
        <div className="dashboard-main">
          {/* Status Banner */}
          {!activeSubscription && !pendingRequest && (
            <div className="status-banner status-banner--inactive">
              <span className="status-banner-icon">○</span>
              <span>{t('dashboard.statusNoSub')}</span>
            </div>
          )}
          {activeSubscription && (
            <div className="status-banner status-banner--active">
              <span className="status-banner-icon">●</span>
              <span>{t('dashboard.statusActive', { plan: activeSubscription.planName })}</span>
            </div>
          )}

          <div className="dashboard-header">
            <div className="dashboard-header-left">
              <h1>{t('dashboard.title')}</h1>
              <button
                className={`scanner-button ${!activeSubscription ? 'scanner-button--locked' : ''}`}
                onClick={() => navigate('/scanner')}
              >
                {!activeSubscription && <span className="scanner-lock-icon">🔒</span>}
                {t('dashboard.openScanner')}
              </button>
            </div>
            <div className="user-info">
              <LanguageSwitcher />
              <div className="user-badge">
                <span className="user-icon">👤</span>
                <span className="user-address">{shortenAddress(user.address)}</span>
              </div>
              <button className="logout-button" onClick={() => {
                localStorage.removeItem('apiKey')
                navigate('/')
              }}>
                {t('dashboard.logout')}
              </button>
            </div>
          </div>

          {/* Pending Payment — Focus Mode Invoice */}
          {pendingRequest ? (
            <section className="invoice-focus">
              <div className="invoice-card">
                {/* Invoice Header */}
                <div className="invoice-header">
                  <div className="invoice-plan">
                    <h2 className="invoice-plan-name">
                      {pendingRequest.plan?.name || 'Unknown'} Plan
                    </h2>
                    {pendingRequest.plan?.description && (
                      <p className="invoice-plan-desc">{pendingRequest.plan.description}</p>
                    )}
                  </div>
                  <div className="invoice-status-group">
                    <span className="invoice-badge">{t('dashboard.pendingPayment')}</span>
                    <div className="invoice-timer">
                      <span className="invoice-timer-icon">⏱</span>
                      <span className="invoice-timer-value">{countdown || '--:--'}</span>
                    </div>
                  </div>
                </div>

                {/* Network Warning */}
                <div className="invoice-warning">
                  <span className="invoice-warning-icon">⚠</span>
                  <span>
                    {t('invoice.networkWarning', { network: getChainName(pendingRequest.request.chainId) })}
                  </span>
                </div>

                {/* Two-panel payment methods */}
                <div className="invoice-panels">
                  {/* Section A: Web3 Wallet Payment */}
                  <div className="invoice-panel invoice-panel--primary">
                    <div className="invoice-panel-header">
                      <span className="invoice-panel-tag">A</span>
                      <h3 className="invoice-panel-title">{t('invoice.walletPayTitle')}</h3>
                    </div>

                    {/* Token Selector */}
                    {pendingRequest.request.supportedTokens.length > 0 && (
                      <div className="invoice-block">
                        <div className="invoice-block-label">{t('invoice.selectToken')}</div>
                        <div className="invoice-tokens">
                          {pendingRequest.request.supportedTokens.map(token => (
                            <button
                              key={token.symbol}
                              className={`invoice-token-card ${selectedToken?.symbol === token.symbol ? 'invoice-token-card--active' : ''}`}
                              onClick={() => setSelectedToken(token)}
                              type="button"
                            >
                              <span className="invoice-token-radio">
                                {selectedToken?.symbol === token.symbol ? '●' : '○'}
                              </span>
                              <img className="invoice-token-icon" src={getTokenIcon(token.symbol)} alt={token.symbol} />
                              <div className="invoice-token-info">
                                <span className="invoice-token-symbol">{token.symbol}</span>
                                <span className="invoice-token-addr">{token.address.slice(0, 6)}...{token.address.slice(-4)}</span>
                              </div>
                              {selectedToken?.symbol === token.symbol && (
                                <span className="invoice-token-check">✓</span>
                              )}
                            </button>
                          ))}
                        </div>
                      </div>
                    )}

                    {/* Amount display */}
                    <div className="invoice-block">
                      <div className="invoice-block-label">{t('invoice.totalAmount')}</div>
                      <div className="invoice-amount-row">
                        <span className="invoice-amount">{formatUsd(pendingRequest.request.amount)}</span>
                        {selectedToken && (
                          <span className="invoice-amount-token">{selectedToken.symbol}</span>
                        )}
                      </div>
                    </div>

                    {/* Web3 Pay Button */}
                    <button
                      className={`invoice-btn-web3 ${isConfirmed ? 'invoice-btn-web3--success' : ''}`}
                      onClick={handlePayment}
                      disabled={!selectedToken || isTxPending || isConfirming || isConfirmed}
                    >
                      {isConfirmed ? (
                        <>{t('invoice.paymentSuccess')}</>
                      ) : isConfirming ? (
                        <><span className="invoice-spinner" />{t('invoice.confirming')}</>
                      ) : isTxPending ? (
                        <>{t('invoice.waitingSignature')}</>
                      ) : (
                        <>{t('invoice.payAmount', { amount: pendingRequest.request.amount, token: selectedToken?.symbol ?? '...' })}</>
                      )}
                    </button>
                  </div>

                  {/* Section B: Manual Transfer */}
                  <div className="invoice-panel invoice-panel--secondary">
                    <div className="invoice-panel-header">
                      <span className="invoice-panel-tag">B</span>
                      <h3 className="invoice-panel-title">{t('invoice.manualTitle')}</h3>
                    </div>

                    {/* QR Code */}
                    <div className="invoice-qr-wrap">
                      <QRCodeSVG
                        value={pendingRequest.request.walletAddress}
                        size={140}
                        bgColor="transparent"
                        fgColor="#ffffff"
                        level="M"
                      />
                      <div className="invoice-network-badge">
                        <img className="chain-icon-inline" src={CHAIN_ICONS[pendingRequest.request.chainId]} alt="" />
                        <span>{getChainName(pendingRequest.request.chainId)}</span>
                      </div>
                    </div>

                    {/* Copyable Amount */}
                    <div className="invoice-block">
                      <div className="invoice-block-label">{t('invoice.exactAmount')}</div>
                      <div className="invoice-copy-row">
                        <span className="invoice-copy-value">{pendingRequest.request.amount}</span>
                        <button
                          className="invoice-copy-btn"
                          onClick={() => handleCopy(pendingRequest.request.amount, 'amount')}
                        >
                          {copiedField === 'amount' ? '✓' : '⧉'}
                        </button>
                      </div>
                    </div>

                    {/* Copyable Address */}
                    <div className="invoice-block">
                      <div className="invoice-block-label">{t('invoice.destAddress')}</div>
                      <div className="invoice-address-box">
                        <span className="invoice-address-text">{pendingRequest.request.walletAddress}</span>
                        <button
                          className="invoice-copy-btn invoice-copy-btn--lg"
                          onClick={() => handleCopy(pendingRequest.request.walletAddress, 'address')}
                        >
                          {copiedField === 'address' ? t('invoice.copied') : t('invoice.copyAddr')}
                        </button>
                      </div>
                    </div>

                    {/* Check Status */}
                    <button
                      className="invoice-btn-check"
                      onClick={() => {
                        queryClient.invalidateQueries({ queryKey: queryKeys.paymentRequests })
                        queryClient.invalidateQueries({ queryKey: queryKeys.subscriptionStatus })
                      }}
                    >
                      {t('invoice.checkStatus')}
                    </button>
                  </div>
                </div>

                {/* Cancel */}
                <div className="invoice-footer">
                  <button
                    className="invoice-btn-cancel"
                    onClick={() => handleCancel(pendingRequest.request.id)}
                  >
                    {t('dashboard.cancelRequest')}
                  </button>
                </div>
              </div>
            </section>
          ) : activeSubscription ? (
            <section className="dashboard-section">
              <div className="system-status-panel">
                <div className="status-panel-top">
                  <div className="status-panel-plan">
                    <span className="status-panel-label">{t('dashboard.systemStatusOnline')}</span>
                    <span className="plan-name-large">{activeSubscription.planName}</span>
                  </div>
                  <div className="status-panel-time">
                    <span className="status-panel-time-label">{t('dashboard.timeLeft')}</span>
                    <span className="status-panel-time-value">
                      {calculateTimeRemaining(new Date(activeSubscription.expiresAt)).days}{t('dashboard.daysShort')}{' '}
                      {calculateTimeRemaining(new Date(activeSubscription.expiresAt)).hours}{t('dashboard.hoursShort')}
                    </span>
                  </div>
                </div>

                <div className="time-progress">
                  <div className="progress-bar-container">
                    <div
                      className="progress-bar-fill"
                      style={{ width: `${100 - calculateProgress(new Date(activeSubscription.startsAt), new Date(activeSubscription.expiresAt))}%` }}
                    />
                  </div>
                </div>

                <div className="system-specs">
                  <div className="spec-item">
                    <span className="spec-icon">⚡</span>
                    <div className="spec-text">
                      <span className="spec-label">{t('dashboard.dataFeed')}</span>
                      <span className="spec-value">{t('dashboard.realTime')}</span>
                    </div>
                  </div>
                  <div className="spec-item">
                    <span className="spec-icon">↗</span>
                    <div className="spec-text">
                      <span className="spec-label">{t('dashboard.telegramAlerts')}</span>
                      <span className="spec-value">{t('dashboard.activeStatus')}</span>
                    </div>
                  </div>
                  <div className="spec-item">
                    <span className="spec-icon">◈</span>
                    <div className="spec-text">
                      <span className="spec-label">{t('dashboard.accessLevel')}</span>
                      <span className="spec-value">{t('dashboard.tier1')}</span>
                    </div>
                  </div>
                </div>

                <div className="status-panel-actions">
                  <button className="status-btn-primary" onClick={() => navigate('/scanner')}>
                    {'[ > '}{t('dashboard.launchScanner')}{' ]'}
                  </button>
                </div>
              </div>
            </section>
          ) : null}

          {/* Available Plans Section — hidden when pending payment (focus mode) */}
          {!activeSubscription && !pendingRequest && (
            <section className="dashboard-section">
              <h2 className="section-title-dashboard">{t('dashboard.selectClearance')}</h2>
              <div className="plans-grid">
                {plans?.filter(plan => plan.isActive).map((plan) => (
                  <div key={plan.id} className={`plan-card ${isPro(plan) ? 'plan-card--featured' : ''}`}>
                    {isPro(plan) && (
                      <div className="plan-badge-popular">{t('dashboard.popular')}</div>
                    )}
                    <div className="plan-header">
                      <h3 className="plan-name">{plan.name}</h3>
                      {plan.description && (
                        <p className="plan-description">{plan.description}</p>
                      )}
                    </div>
                    
                    <div className="plan-price">
                      <span className="price-amount">{formatUsd(plan.price)}</span>
                      <span className="price-period">{t('pricing.perDays', { days: plan.durationDays })}</span>
                    </div>

                    <ul className="plan-features">
                      {getPlanFeatures(plan).map((featureKey) => (
                        <li key={featureKey} className="plan-feature-item">
                          <span className="plan-feature-check">✓</span>
                          <span>{t(featureKey)}</span>
                        </li>
                      ))}
                    </ul>
                    
                    <button
                      className={`plan-button ${isPro(plan) ? 'plan-button--primary' : 'plan-button--outlined'}`}
                      onClick={() => setSelectedPlanId(plan.id)}
                    >
                      {t('dashboard.initializeUpgrade')}
                    </button>
                  </div>
                ))}
              </div>
            </section>
          )}

          {/* Selected Plan Modal */}
          {selectedPlan && (
            <div className="modal-overlay" onClick={() => setSelectedPlanId(null)}>
              <div className="modal-content" onClick={(e) => e.stopPropagation()}>
                <div className="modal-header">
                  <h2>{t('dashboard.createPayment')}</h2>
                  <button className="modal-close" onClick={() => setSelectedPlanId(null)}>×</button>
                </div>
                
                <div className="modal-body">
                  <div className="plan-details">
                    <h3>{selectedPlan.name}</h3>
                    {selectedPlan.description && (
                      <p>{selectedPlan.description}</p>
                    )}
                    <div className="plan-price-large">
                      <span className="price-amount">{formatUsd(selectedPlan.price)}</span>
                      <span className="price-period">{t('pricing.perDays', { days: selectedPlan.durationDays })}</span>
                    </div>
                  </div>

                  <div className="chain-selector">
                    <label className="chain-selector-label">{t('dashboard.selectNetwork')}</label>
                    <div className="chain-options">
                      {CHAIN_OPTIONS.map(chain => (
                        <button
                          key={chain.id}
                          className={`chain-option ${selectedChainId === chain.id ? 'active' : ''}`}
                          onClick={() => setSelectedChainId(chain.id)}
                        >
                          <img className="chain-icon" src={CHAIN_ICONS[chain.id]} alt={chain.name} />
                          <span className="chain-name">{chain.name}</span>
                        </button>
                      ))}
                    </div>
                  </div>
                  
                  <button
                    className="primary-button"
                    onClick={() => handleCreatePaymentRequest(selectedPlan.id)}
                    disabled={isCreating}
                  >
                    {isCreating ? t('dashboard.creating') : t('dashboard.createBtn')}
                  </button>
                </div>
              </div>
            </div>
          )}
        </div>

        {/* Sidebar with Payment Requests */}
        <aside className="dashboard-sidebar">
          <h2>{t('dashboard.transactionLog')}</h2>
          {paymentRequests && paymentRequests.length > 0 ? (
            <div className="transaction-log">
              {paymentRequests.map((request, index) => {
                const plan = plans?.find(p => p.id === request.planId)
                  ?? plans?.find(p => request.planId.toLowerCase().includes(p.name.toLowerCase()))
                const status = request.status.toLowerCase()
                const statusLabel = status === 'paid' ? t('dashboard.success') : status === 'cancelled' ? t('dashboard.failed') : t('dashboard.pendingStatus')
                const statusClass = status === 'paid' ? 'log-success' : status === 'cancelled' ? 'log-failed' : 'log-pending'
                const statusIcon = status === 'paid' ? '✓' : status === 'cancelled' ? '✕' : '◌'
                
                return (
                  <div key={request.id} className="log-entry">
                    <div className="log-header">
                      <span className="log-index">{String(paymentRequests.length - index).padStart(3, '0')}</span>
                      <span className={`log-status ${statusClass}`}>
                        <span className="log-status-icon">{statusIcon}</span>
                        {statusLabel}
                      </span>
                    </div>
                    <div className="log-details">
                      <div className="log-line">
                        <span className="log-label">{t('dashboard.plan')}</span>
                        <span className="log-value">{plan?.name || 'Unknown'}</span>
                      </div>
                      <div className="log-line">
                        <span className="log-label">{t('dashboard.amt')}</span>
                        <span className="log-value">{formatUsd(request.amount)}</span>
                      </div>
                      <div className="log-line">
                        <span className="log-label">{t('dashboard.networkShort')}</span>
                        <span className="log-value chain-value">
                          <img className="chain-icon-inline" src={CHAIN_ICONS[request.chainId]} alt="" />
                          {getChainName(request.chainId)}
                        </span>
                      </div>
                      {request.tokenSymbol && (
                        <div className="log-line">
                          <span className="log-label">{t('dashboard.token')}</span>
                          <span className="log-value">{request.tokenSymbol}</span>
                        </div>
                      )}
                      <div className="log-line">
                        <span className="log-label">{t('dashboard.date')}</span>
                        <span className="log-value log-date">
                          {new Date(request.expiresAt).toLocaleDateString('en-US', {
                            month: '2-digit',
                            day: '2-digit',
                            year: '2-digit'
                          })}
                        </span>
                      </div>
                    </div>
                  </div>
                )
              })}
            </div>
          ) : (
            <div className="empty-state-sidebar">
              <p>{t('dashboard.noTransactions')}</p>
            </div>
          )}
        </aside>
      </div>
    </div>
  )
}

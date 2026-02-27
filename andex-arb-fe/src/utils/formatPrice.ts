export function formatUsd(amount: string, decimals: number = 2): string {
  const num = parseFloat(amount)
  if (isNaN(num)) return amount
  return `$${num.toLocaleString('en-US', { minimumFractionDigits: decimals, maximumFractionDigits: decimals })}`
}

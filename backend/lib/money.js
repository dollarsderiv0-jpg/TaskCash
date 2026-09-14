/** Centralized money formatting — backend mirror of frontend/assets/js/money.js. */
function formatMoney(amount, currencyCode, decimals = 2) {
  const v = Number(amount) || 0;
  const cc = String(currencyCode || '').toUpperCase() || 'KES';
  return `${cc} ${v.toLocaleString('en-US', { minimumFractionDigits: decimals, maximumFractionDigits: decimals })}`;
}

module.exports = { formatMoney };

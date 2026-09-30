// Blink-to-Stock website: mobile menu and live drops from the Blink API (same origin, /api).
;(function () {
  const toggle = document.querySelector('.nav-toggle')
  const links = document.getElementById('nav-links')
  if (toggle && links) {
    toggle.addEventListener('click', () => {
      const open = links.classList.toggle('open')
      toggle.setAttribute('aria-expanded', String(open))
    })
    links.addEventListener('click', (e) => {
      if (e.target.closest('a')) {
        links.classList.remove('open')
        toggle.setAttribute('aria-expanded', 'false')
      }
    })
  }

  const list = document.getElementById('drop-list')
  if (!list) return

  const LABEL = { GIFT: 'Gift', TAP_RUSH: 'Tap Rush', EARLY_CLAIM: 'Early Claim', REFERRAL: 'Referral', SEEKER: 'Seeker Drop' }

  function el(tag, props, children) {
    const node = document.createElement(tag)
    Object.assign(node, props || {})
    for (const c of children || []) node.append(c)
    return node
  }

  // Display only: raw base units → shares, using the stock's current multiplier.
  function shares(raw, asset) {
    if (!asset) return null
    const n = (Number(raw) / Math.pow(10, asset.decimals)) * (asset.multiplier == null ? 1 : asset.multiplier)
    return n.toLocaleString(undefined, { maximumFractionDigits: 6 })
  }

  function empty() {
    list.replaceChildren(
      el('div', { className: 'card empty', style: 'grid-column: 1 / -1' }, [
        el('h3', { textContent: 'No live drops right now' }),
        el('p', { textContent: 'New drops appear here the moment a creator funds one. Got a QR code from a friend? Scan it with the app.' }),
        el('a', { className: 'btn btn-primary', href: '/download/blink-to-stock.apk', textContent: 'Get the app' }),
      ]),
    )
  }

  Promise.all([fetch('/api/v1/campaigns'), fetch('/api/v1/xstocks')])
    .then(async ([c, x]) => {
      if (!c.ok) throw new Error('unavailable')
      const campaigns = (await c.json()).campaigns || []
      const assets = x.ok ? (await x.json()).xstocks : []
      const claimable = campaigns.filter((d) => d.rewardPerClaimRaw)
      if (!claimable.length) return empty()
      list.replaceChildren(
        ...claimable.slice(0, 9).map((d) => {
          const asset = assets.find((a) => a.mint === d.mint)
          const reward = BigInt(d.rewardPerClaimRaw)
          const total = BigInt(d.allowanceRaw) / reward
          const taken = BigInt(d.claimedRaw) / reward
          const pct = total > 0n ? Number((taken * 100n) / total) : 0
          const per = shares(d.rewardPerClaimRaw, asset)
          return el('a', { className: 'card drop', href: '/c/' + d.id }, [
            el('div', { className: 'drop-top' }, [
              el('span', { className: 'badge live', textContent: LABEL[d.type] || 'Drop' }),
              el('span', { className: 'badge neutral', textContent: d.cluster === 'mainnet-beta' ? 'Solana' : 'Devnet · test' }),
            ]),
            el('div', { className: 'drop-symbol', textContent: d.xstockSymbol }),
            el('p', { textContent: per ? per + ' ' + d.xstockSymbol + ' per person' : 'Stock drop' }),
            el('div', { className: 'meter' }, [el('span', { style: 'width:' + Math.min(100, pct) + '%' })]),
            el('small', { className: 'muted', textContent: taken + ' of ' + total + ' claimed' }),
          ])
        }),
      )
    })
    .catch(empty)
})()

/* Read-only context for the notebook's existing retirement paths. */
(function () {
  'use strict';
  function annualized(first, last, years) {
    if (![first, last, years].every(Number.isFinite) || first <= 0 || last <= 0 || years <= 0) return null;
    return (Math.pow(last / first, 1 / years) - 1) * 100;
  }
  function windows(data, scenario) {
    const prices = data[scenario], years = data.years;
    if (!Array.isArray(prices) || !Array.isArray(years) || prices.length !== years.length || !years.length) return [];
    return [1, 2, 4, 10].map(span => {
      const i = years.indexOf(years[0] + span);
      return {span, start: years[0], end: i < 0 ? null : years[i], rate: i < 0 ? null : annualized(prices[0], prices[i], span)};
    });
  }
  function declines(data, scenario) {
    return data.years.flatMap((year, i) => i > 0 && data[scenario][i] < data[scenario][i - 1]
      ? [{year, rate: (data[scenario][i] / data[scenario][i - 1] - 1) * 100}] : []);
  }
  function priceLabel(value) {
    for (const [scale,suffix] of [[1e12,'T'],[1e9,'B'],[1e6,'M'],[1e3,'K']]) {
      if (Math.abs(value)>=scale) return '$'+(value/scale).toLocaleString('en-US',{maximumFractionDigits:2})+suffix;
    }
    return '$'+value.toLocaleString('en-US',value!==0&&Math.abs(value)<.01?{maximumSignificantDigits:4}:{minimumFractionDigits:value%1?2:0,maximumFractionDigits:2});
  }
  function priceTicks(prices) {
    const positive=prices.filter(p=>Number.isFinite(p)&&p>0);
    if (!positive.length) return {values:[],labels:[]};
    const min=Math.min(...positive),max=Math.max(...positive);
    let values=[];
    if (max/min<2 && max>min) {
      const magnitude=10**Math.floor(Math.log10((max-min)/4));
      const raw=(max-min)/4/magnitude;
      const step=(raw<=1?1:raw<=2?2:raw<=5?5:10)*magnitude;
      for(let n=Math.floor(min/step);n<=Math.ceil(max/step);n++)values.push(n*step);
    } else {
      for(let power=Math.floor(Math.log10(min));power<=Math.ceil(Math.log10(max));power++) {
        for(const multiplier of [1,2,5])values.push(multiplier*10**power);
      }
    }
    values=values.filter(v=>v>0&&v>=min/1.5&&v<=max*1.5);
    return {values,labels:values.map(priceLabel)};
  }
  if (typeof module !== 'undefined' && module.exports) module.exports = {annualized, windows, declines, priceLabel, priceTicks};
  if (typeof document === 'undefined') return;
  const pct = n => n === null || !Number.isFinite(n) ? 'Unavailable' : `${n >= 0 ? '+' : ''}${n.toFixed(2)}%`;
  function node(tag, text, className) {
    const el = document.createElement(tag);
    if (text !== undefined) el.textContent = text;
    if (className) el.className = className;
    return el;
  }
  function init() {
    // `d` belongs to the notebook's classic script. Never copy or replace its paths.
    if (typeof d === 'undefined' || !Array.isArray(d.years) || document.getElementById('cw-cagr-context')) return;
    const select = document.getElementById('scenarioSelect');
    const heading = document.querySelector('.header');
    if (!select || !heading || !d.years.every(Number.isFinite)) return;
    const section = node('section', undefined, 'cw-cagr-context');
    section.id = 'cw-cagr-context';
    section.setAttribute('aria-label', 'Scenario CAGR and four-year cycle');
    section.append(node('h2', 'Growth assumptions & cycle returns'));
    section.append(node('p', 'Three growth years, then one simulated bear year. Legend percentages are growth-year assumptions; effective compound returns include the declines. This is an illustration, not a forecast.'));
    const assumptions = node('p', '', 'cw-cycle-assumptions');
    const cards = node('div', undefined, 'cw-cagr-cards');
    cards.setAttribute('aria-live', 'polite');
    section.append(assumptions, cards);
    const endYear = d.years[d.years.length - 1];
    section.append(node('p', `These are modeled returns from ${d.years[0]} to the indicated year, not historical returns. The first plotted value already includes the model’s initial multiplier and first decline; neither is counted again. Values use the chart’s rounded prices.`, 'cw-cagr-note'));
    const cycleLine = node('div', undefined, 'cw-cycle-years');
    cycleLine.setAttribute('aria-label', 'Assumed cycle years');
    d.years.forEach(year => cycleLine.append(node('span', `${year}${(year - 2026) % 4 === 0 ? ' · bear' : ''}`, (year - 2026) % 4 === 0 ? 'cw-bear-year' : '')));
    section.append(cycleLine);
    const grid=document.querySelector('.grid');
    const matrix=document.querySelector('table');
    if (grid && matrix) {
      const previousCard=matrix.closest('.card');
      // Crypto exports have duplicate headings outside their container. MSTR
      // already wraps its table; keep its explanatory notes with assumptions.
      if (previousCard && !grid.contains(previousCard)) {
        [...previousCard.querySelectorAll('p')].forEach(p=>section.append(p));
      } else {
        while (matrix.previousElementSibling && /^H[23]$/.test(matrix.previousElementSibling.tagName)
               && /Projection|Matrix/i.test(matrix.previousElementSibling.textContent)) matrix.previousElementSibling.remove();
      }
      const matrixCard=node('section',undefined,'cw-projection-matrix');
      matrixCard.setAttribute('aria-label','Projection matrix');
      matrixCard.append(node('h2','Projection matrix'));
      const scroll=node('div',undefined,'cw-matrix-scroll');scroll.append(matrix);matrixCard.append(scroll);
      grid.after(matrixCard);matrixCard.after(section);
      if (previousCard && !grid.contains(previousCard)) previousCard.remove();
    } else (grid || heading).after(section);
    heading.append(node('p', 'Four-year cycle illustration · shaded years are assumed bear years · effective CAGR below', 'cw-cagr-note'));
    function update() {
      const scenario = select.value;
      if (!Array.isArray(d[scenario])) return;
      const rate = select.selectedOptions[0].textContent.match(/([\d.]+)%/);
      const drops = declines(d, scenario);
      assumptions.textContent = `${select.selectedOptions[0].textContent.split(' (')[0]}: ${rate ? rate[1] + '% in growth years' : 'see scenario assumptions'}; ${drops.length ? 'approximately ' + Math.abs(drops[0].rate).toFixed(1) + '% decline in each bear year' : 'no declining step in this path'}. Bear years are fixed assumptions, not predicted dates.`;
      cards.replaceChildren();
      const results = windows(d, scenario);
      results.push({span: endYear - d.years[0], start: d.years[0], end: endYear, rate: annualized(d[scenario][0], d[scenario].at(-1), endYear - d.years[0])});
      results.forEach((item, i) => {
        const card = node('div', undefined, 'cw-cagr-card');
        card.append(node('span', i === 4 ? 'Full path CAGR' : `${item.span}-year path CAGR`), node('strong', pct(item.rate)), node('small', item.end === null ? 'Insufficient modeled years' : `${item.start}–${item.end}`));
        cards.append(card);
      });
    }
    select.addEventListener('change', () => {
      update();
      const plot = document.querySelector('.plotly-graph-div');
      const label = select.selectedOptions[0].textContent.split(' (')[0];
      if (plot && Array.isArray(plot.data) && typeof Plotly !== 'undefined') {
        Promise.resolve(Plotly.restyle(plot, 'visible', plot.data.map(trace => trace.name.startsWith(label + ' Price') ? true : 'legendonly'))).catch(() => {});
      }
    });
    update();
    // Shade assumed bear years without changing any trace, axis or calculator input.
    const graph = document.querySelector('.plotly-graph-div');
    let decorated = false;
    function shade() {
      if (decorated || !graph || !graph.layout || typeof Plotly === 'undefined') return;
      decorated = true;
      const shapes = [...(graph.layout.shapes || [])];
      d.years.filter(year => (year - 2026) % 4 === 0).forEach(year => shapes.push({type:'rect', xref:'x', yref:'paper', x0:year - 0.35, x1:year + 0.35, y0:0, y1:1, fillcolor:'rgba(239,68,68,0.12)', line:{width:0}, layer:'below'}));
      const ticks=priceTicks(['Bear','Base','Bull','Uber'].flatMap(key=>d[key]||[]));
      const yearTicks=d.years.filter((year,i)=>i%4===0||i===d.years.length-1);
      Promise.resolve(Plotly.relayout(graph, {shapes,'yaxis.tickmode':'array',
        'yaxis.tickvals':ticks.values,'yaxis.ticktext':ticks.labels,
        'yaxis.title.text':'Price (USD · log scale)','yaxis.automargin':true,
        'xaxis.tickmode':'array','xaxis.tickvals':yearTicks,'xaxis.ticktext':yearTicks.map(String),
        'margin.l':85,'margin.b':130,'legend.y':-.12,'legend.yanchor':'top',
        'hoverlabel.namelength':-1})).catch(() => {});
    }
    if (graph && typeof graph.on === 'function') graph.on('plotly_afterplot', shade);
    shade();
    const script = document.querySelector('script[data-cw-retirement]');
    if (script && script.dataset.historyUrl) {
      const url = new URL(script.dataset.historyUrl, location.href);
      if (url.origin !== location.origin) return;
      fetch(url).then(response => {if (!response.ok) throw new Error('No historical page'); return response.text();}).then(markup => {
        const doc = new DOMParser().parseFromString(markup, 'text/html');
        const rows = [...doc.querySelectorAll('.cagr-table:first-of-type tbody tr')].slice(0, 4);
        if (rows.length !== 4) return;
        const history = node('section', undefined, 'cw-cagr-history');
        history.append(node('h3', 'Historical Bitcoin CAGR'));
        const stamp = doc.querySelector('time');
        history.append(node('p', `Observed price returns${stamp ? ' to ' + stamp.textContent : ''}, separate from the scenario above.`));
        const historicalCards = node('div', undefined, 'cw-cagr-cards');
        rows.forEach(row => {
          const cells = row.querySelectorAll('th,td');
          const card = node('div', undefined, 'cw-cagr-card');
          card.append(node('span', cells[0].textContent), node('strong', cells[1].textContent));
          historicalCards.append(card);
        });
        const link = node('a', 'See historical dates, prices and calculation');
        link.href = url.href;
        history.append(historicalCards, link);
        section.append(history);
      }).catch(() => {});
    }
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init, {once:true});
  else init();
})();

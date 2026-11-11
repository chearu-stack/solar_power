(() => {
  'use strict';

  const HEADER_BYTES = 16;
  const MONTH_COUNT = 12;
  const MONTH_LABELS = ['Янв', 'Фев', 'Мар', 'Апр', 'Май', 'Июн', 'Июл', 'Авг', 'Сен', 'Окт', 'Ноя', 'Дек'];
  const MONTH_NAMES = ['январь', 'февраль', 'март', 'апрель', 'май', 'июнь', 'июль', 'август', 'сентябрь', 'октябрь', 'ноябрь', 'декабрь'];
  let activeGrid = null;
  let activePlaneIrradiance = null;
  let cityPlaces = null;
  let cityPlacesPromise = null;
  const cityOptions = new Map();

  function parseGrid(buffer) {
    if (!(buffer instanceof ArrayBuffer) || buffer.byteLength < HEADER_BYTES) {
      throw new Error('Invalid grid size');
    }

    const view = new DataView(buffer);
    const magic = String.fromCharCode(...new Uint8Array(buffer, 0, 4));
    const latMin = view.getInt16(4, true);
    const latMax = view.getInt16(6, true);
    const lonMin = view.getInt16(8, true);
    const lonMax = view.getInt16(10, true);
    const step = view.getUint8(12) / 10;
    const months = view.getUint8(13);

    if (magic !== 'KTG1' || ![1, 2].includes(step) || months !== MONTH_COUNT || latMax < latMin || lonMax < lonMin) {
      throw new Error('Invalid grid header');
    }

    const rowSpan = (latMax - latMin) / step;
    const columnSpan = (lonMax - lonMin) / step;
    if (!Number.isInteger(rowSpan) || !Number.isInteger(columnSpan)) throw new Error('Invalid grid bounds');
    const rows = rowSpan + 1;
    const columns = columnSpan + 1;
    const expectedBytes = HEADER_BYTES + rows * columns * MONTH_COUNT;
    if (buffer.byteLength !== expectedBytes) throw new Error('Invalid grid length');

    return { view, latMin, latMax, lonMin, lonMax, step, rows, columns };
  }

  function sampleMonthlyKt(grid, latitude, longitude) {
    if (!grid || !Number.isFinite(latitude) || !Number.isFinite(longitude)) return null;
    if (latitude < grid.latMin || latitude > grid.latMax) return null;

    let lon = longitude;
    while (lon < grid.lonMin) lon += 360;
    while (lon > grid.lonMax && lon - 360 >= grid.lonMin) lon -= 360;
    if (lon < grid.lonMin || lon > grid.lonMax) return null;

    const rowPosition = (latitude - grid.latMin) / grid.step;
    const columnPosition = (lon - grid.lonMin) / grid.step;
    const row0 = Math.floor(rowPosition);
    const column0 = Math.floor(columnPosition);
    const row1 = Math.min(row0 + 1, grid.rows - 1);
    const column1 = Math.min(column0 + 1, grid.columns - 1);
    const rowFraction = rowPosition - row0;
    const columnFraction = columnPosition - column0;
    const candidates = [
      [row0, column0, (1 - rowFraction) * (1 - columnFraction)],
      [row0, column1, (1 - rowFraction) * columnFraction],
      [row1, column0, rowFraction * (1 - columnFraction)],
      [row1, column1, rowFraction * columnFraction],
    ];

    return Array.from({ length: MONTH_COUNT }, (_, month) => {
      let weighted = 0;
      let weightTotal = 0;
      for (const [row, column, weight] of candidates) {
        if (!weight) continue;
        const offset = HEADER_BYTES + (row * grid.columns + column) * MONTH_COUNT + month;
        const encoded = grid.view.getUint8(offset);
        if (encoded === 0) return null;
        weighted += (encoded / 250) * weight;
        weightTotal += weight;
      }
      return weightTotal ? weighted / weightTotal : null;
    });
  }

  function normalizeCityName(value) {
    return String(value)
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .toLocaleLowerCase('ru-RU')
      .replace(/ё/g, 'е')
      .replace(/[^\p{L}\p{N}]+/gu, ' ')
      .trim();
  }

  async function loadCityPlaces() {
    if (cityPlaces) return cityPlaces;
    if (!cityPlacesPromise) {
      cityPlacesPromise = fetch('assets/data/cities-grid.json')
        .then(response => {
          if (!response.ok) throw new Error(`City index request failed: ${response.status}`);
          return response.json();
        })
        .then(data => {
          if (!Array.isArray(data.places)) throw new Error('Invalid city index');
          cityPlaces = data.places;
          return cityPlaces;
        })
        .catch(error => {
          cityPlacesPromise = null;
          throw error;
        });
    }
    return cityPlacesPromise;
  }

  function cityTerms(place) {
    return [place[0], ...place[1]].map(normalizeCityName).filter(Boolean);
  }

  function cityDisplayName(place) {
    return place[1].find(alias => /[\u0400-\u052f]/.test(alias)) || place[0];
  }

  function cityAreaLabel(place) {
    const adminKey = `${place[4]}.${place[5]}`;
    const knownAreas = {
      'RU.51': 'Нижегородская область (регион 52)',
      'RU.42': 'Ленинградская область (регион 47)',
    };
    if (knownAreas[adminKey]) return knownAreas[adminKey];
    return ({ RU: 'Россия', UA: 'Украина' })[place[4]] || place[4];
  }

  function cityOptionLabel(place) {
    return `${cityDisplayName(place)} — ${cityAreaLabel(place)} [${Number(place[2]).toFixed(5)}, ${Number(place[3]).toFixed(5)}]`;
  }

  function renderCitySuggestions(query, places) {
    const datalist = document.getElementById('citySuggestions');
    if (!datalist) return;
    datalist.replaceChildren();
    cityOptions.clear();
    const needle = normalizeCityName(query);
    if (needle.length < 2) return;

    const matches = [];
    for (const place of places) {
      const matchingTerm = cityTerms(place).find(term => term.startsWith(needle));
      if (matchingTerm) matches.push({ place, matchingTerm });
    }
    matches.sort((a, b) => b.place[6] - a.place[6]);

    for (const { place } of matches.slice(0, 12)) {
      const value = cityOptionLabel(place);
      cityOptions.set(value, place);
      const option = document.createElement('option');
      option.value = value;
      option.label = value;
      datalist.append(option);
    }
  }

  function findExactCity(query, places) {
    const selectedCoordinates = String(query).match(/^(.+?)\s+—\s+.+?\s+\[(-?\d+(?:\.\d+)?),\s*(-?\d+(?:\.\d+)?)\]$/u);
    if (selectedCoordinates) {
      const term = normalizeCityName(selectedCoordinates[1]);
      const latitude = Number(selectedCoordinates[2]);
      const longitude = Number(selectedCoordinates[3]);
      return places.filter(place => cityTerms(place).includes(term)
        && Math.abs(Number(place[2]) - latitude) < 0.00001
        && Math.abs(Number(place[3]) - longitude) < 0.00001);
    }

    // Accept saved suggestions from the earlier `name — CC-admin1` format.
    const selectedOption = String(query).match(/^(.+?)\s+—\s+([A-Z]{2})(?:-([A-Z0-9]+))?$/i);
    if (selectedOption) {
      const term = normalizeCityName(selectedOption[1]);
      const country = selectedOption[2].toUpperCase();
      const admin1 = selectedOption[3] || '';
      return places.filter(place => place[4] === country && (!admin1 || place[5] === admin1) && cityTerms(place).includes(term));
    }
    const normalized = normalizeCityName(query);
    const matches = places.filter(place => cityTerms(place).includes(normalized));
    return matches;
  }

  function renderMonthlyProfile(place, profile, latitude = Number(place[2]), longitude = Number(place[3])) {
    const profileElement = document.getElementById('solarProfile');
    const irradianceGrid = document.getElementById('planeIrradianceGrid');
    const cityStatus = document.getElementById('cityStatus');
    if (!profileElement || !irradianceGrid || !cityStatus) return;

    activePlaneIrradiance = window.SolarResource?.monthlyPlaneIrradiance(profile, latitude) || null;
    irradianceGrid.replaceChildren();
    MONTH_LABELS.forEach((month, index) => {
      const monthCell = document.createElement('div');
      monthCell.className = 'month-cell';
      monthCell.dataset.monthIndex = String(index);
      const monthLabel = document.createElement('strong');
      monthLabel.textContent = month;
      const resourceReading = document.createElement('span');
      resourceReading.className = 'month-resource';
      resourceReading.textContent = Number.isFinite(activePlaneIrradiance?.[index])
        ? activePlaneIrradiance[index].toFixed(3)
        : '—';
      const panelCountReading = document.createElement('span');
      panelCountReading.className = 'month-panel-count';
      panelCountReading.dataset.monthPanels = '';
      panelCountReading.textContent = 'панелей: —';
      monthCell.append(monthLabel, resourceReading, panelCountReading);
      irradianceGrid.append(monthCell);
    });
    profileElement.hidden = false;

    if (!activePlaneIrradiance || activePlaneIrradiance.some(value => value === null)) {
      cityStatus.className = 'city-status warning';
      cityStatus.textContent = 'Для некоторых месяцев нет данных сетки. Расчёт доступен только для периода с полными данными.';
    } else if (activePlaneIrradiance.some(value => value === 0)) {
      cityStatus.className = 'city-status warning';
      cityStatus.textContent = 'В некоторые месяцы расчётный солнечный ресурс равен нулю.';
    } else {
      cityStatus.className = 'city-status';
      cityStatus.textContent = `Солнечные данные загружены для ${cityDisplayName(place)}, ${cityAreaLabel(place)}. Точка расчёта: ${latitude.toFixed(5)}°, ${longitude.toFixed(5)}°.`;
    }
    window.dispatchEvent(new Event('solar:profile-updated'));
  }

  function renderLocationAtCoordinates(place, latitudeField, longitudeField) {
    const cityStatus = document.getElementById('cityStatus');
    const profileElement = document.getElementById('solarProfile');
    const latitude = Number(latitudeField?.value);
    const longitude = Number(longitudeField?.value);
    if (!cityStatus || !profileElement) return;

    if (!latitudeField?.value || !longitudeField?.value
      || !Number.isFinite(latitude) || !Number.isFinite(longitude)
      || latitude < -90 || latitude > 90 || longitude < -180 || longitude > 180) {
      cityStatus.className = 'city-status warning';
      activePlaneIrradiance = null;
      cityStatus.textContent = 'Проверьте широту и долготу: широта от −90° до 90°, долгота от −180° до 180°.';
      profileElement.hidden = true;
      window.dispatchEvent(new Event('solar:profile-updated'));
      return;
    }

    if (!activeGrid) return;
    const profile = sampleMonthlyKt(activeGrid, latitude, longitude);
    if (!profile) {
      cityStatus.className = 'city-status warning';
      activePlaneIrradiance = null;
      cityStatus.textContent = 'Для этих координат нет покрытия в солнечной сетке.';
      profileElement.hidden = true;
      window.dispatchEvent(new Event('solar:profile-updated'));
      return;
    }
    renderMonthlyProfile(place, profile, latitude, longitude);
  }

  async function updateCityLocation(value) {
    const cityStatus = document.getElementById('cityStatus');
    const profileElement = document.getElementById('solarProfile');
    if (!cityStatus) return;
    if (!value) {
      activePlaneIrradiance = null;
      cityStatus.className = 'city-status';
      cityStatus.textContent = '';
      if (profileElement) profileElement.hidden = true;
      window.dispatchEvent(new Event('solar:profile-updated'));
      return;
    }
    try {
      const places = await loadCityPlaces();
      if (document.getElementById('city')?.value !== value) return;
      const selected = cityOptions.get(value);
      if (!selected) renderCitySuggestions(value, places);
      const exact = selected ? [selected] : findExactCity(value, places);
      if (exact.length > 1) {
        activePlaneIrradiance = null;
        cityStatus.className = 'city-status';
        cityStatus.textContent = 'Найдено несколько населённых пунктов. Выберите вариант с нужным регионом и координатами.';
        if (profileElement) profileElement.hidden = true;
        window.dispatchEvent(new Event('solar:profile-updated'));
        return;
      }
      if (!exact.length) {
        activePlaneIrradiance = null;
        cityStatus.className = 'city-status';
        cityStatus.textContent = normalizeCityName(value).length >= 3 ? 'Город не найден в локальном справочнике.' : '';
        if (profileElement) profileElement.hidden = true;
        window.dispatchEvent(new Event('solar:profile-updated'));
        return;
      }
      const place = exact[0];
      const latitudeField = document.getElementById('latitude');
      const longitudeField = document.getElementById('longitude');
      if (latitudeField && !latitudeField.value) latitudeField.value = Number(place[2]).toFixed(5);
      if (longitudeField && !longitudeField.value) longitudeField.value = Number(place[3]).toFixed(5);
      if (!activeGrid) return;
      renderLocationAtCoordinates(place, latitudeField, longitudeField);
    } catch {
      cityStatus.className = 'city-status';
      cityStatus.textContent = 'Локальный справочник городов не загружен.';
      if (profileElement) profileElement.hidden = true;
      activePlaneIrradiance = null;
      window.dispatchEvent(new Event('solar:profile-updated'));
    }
  }

  function parseLocalizedNumber(value) {
    const normalized = String(value ?? '').trim().replace(/\s/g, '').replace(',', '.');
    if (!normalized) return null;
    const parsed = Number(normalized);
    return Number.isFinite(parsed) ? parsed : null;
  }

  function dailyConsumptionKwh(consumers) {
    return consumers.reduce((sum, item) => {
      const power = parseLocalizedNumber(item.powerW);
      const count = parseLocalizedNumber(item.count);
      const hours = parseLocalizedNumber(item.hoursPerDay);
      if ([power, count, hours].some(value => value === null) || power < 0 || count < 0 || hours < 0) {
        throw new RangeError('Consumer values must be non-negative numbers');
      }
      return sum + power * count * hours / 1000;
    }, 0);
  }

  function batteryCapacityAh({ dailyEnergyWh, days, systemVoltage, dod, temperatureFactor }) {
    const values = [dailyEnergyWh, days, systemVoltage, dod, temperatureFactor];
    if (!values.every(Number.isFinite) || values.some(value => value <= 0) || dod > 1 || temperatureFactor > 1) {
      return null;
    }
    return dailyEnergyWh * days / (systemVoltage * dod * temperatureFactor);
  }

  function initializeForm() {
    const form = document.getElementById('calcForm');
    const list = document.getElementById('consumerList');
    if (!form || !list) return;

    const storageKey = 'solar-estimator-v2';
    let saved = {};
    try { saved = JSON.parse(localStorage.getItem(storageKey) || '{}'); } catch {}
    if (!saved || typeof saved !== 'object' || Array.isArray(saved)) saved = {};

    function addConsumer(item = {}) {
      if (list.children.length >= 30) return;
      const row = document.createElement('div');
      row.className = 'consumer-row';
      row.innerHTML = `
        <label>Прибор<input data-consumer="label" type="text" maxlength="60" placeholder="Например, холодильник"></label>
        <label>Мощность, Вт<input data-consumer="powerW" type="number" min="0" max="20000" step="0.1" inputmode="decimal"></label>
        <label>Количество<input data-consumer="count" type="number" min="0" max="100" step="1" inputmode="numeric"></label>
        <label>Часов в день<input data-consumer="hoursPerDay" type="number" min="0" max="24" step="0.1" inputmode="decimal"></label>
        <button class="icon-button remove-consumer" type="button" aria-label="Удалить прибор">×</button>`;
      for (const input of row.querySelectorAll('[data-consumer]')) {
        input.value = item[input.dataset.consumer] ?? '';
      }
      list.append(row);
    }

    for (const item of Array.isArray(saved.consumers) ? saved.consumers : []) addConsumer(item);
    if (!list.children.length) addConsumer();
    for (const field of form.querySelectorAll('[name]')) {
      if (Object.hasOwn(saved, field.name)) field.value = saved[field.name];
    }

    const periodField = form.elements.solarPeriod;
    const monthField = document.getElementById('solarMonthField');
    function syncPeriodControls() {
      if (monthField) monthField.hidden = periodField.value !== 'month';
    }
    syncPeriodControls();

    function update() {
      const consumers = [...list.querySelectorAll('.consumer-row')].map(row => ({
        label: row.querySelector('[data-consumer="label"]').value,
        powerW: row.querySelector('[data-consumer="powerW"]').value,
        count: row.querySelector('[data-consumer="count"]').value,
        hoursPerDay: row.querySelector('[data-consumer="hoursPerDay"]').value,
      }));
      const active = consumers.filter(item => item.label || item.powerW !== '' || item.count !== '' || item.hoursPerDay !== '');
      const complete = active.filter(item => item.powerW !== '' && item.count !== '' && item.hoursPerDay !== '');
      const consumersValid = active.length > 0
        && complete.length === active.length
        && [...list.querySelectorAll('input[type="number"]')].every(input => input.value === '' || input.validity.valid)
        && complete.every(item => [item.powerW, item.count, item.hoursPerDay].every(value => parseLocalizedNumber(value) > 0));
      let energyKwh = null;
      let connectedPowerW = null;
      try {
        if (consumersValid) {
          energyKwh = dailyConsumptionKwh(complete);
          connectedPowerW = complete.reduce((sum, item) => sum + parseLocalizedNumber(item.powerW) * parseLocalizedNumber(item.count), 0);
        }
      } catch {}

      const energyOutput = document.getElementById('dailyEnergy');
      const peakOutput = document.getElementById('peakLoad');
      const batteryOutput = document.getElementById('batteryCapacity');
      const designMonthOutput = document.getElementById('designMonth');
      const panelCountOutput = document.getElementById('panelCount');
      const panelPowerOutput = document.getElementById('panelArrayPower');
      const panelAreaOutput = document.getElementById('panelArea');
      const periodNotice = document.getElementById('solarPeriodNotice');
      if (energyOutput) energyOutput.textContent = energyKwh > 0 ? `${energyKwh.toFixed(2)} кВт·ч` : 'Заполните приборы';
      if (peakOutput) peakOutput.textContent = connectedPowerW > 0 ? `${(connectedPowerW / 1000).toFixed(2)} кВт` : '—';

      const inverterEfficiency = parseLocalizedNumber(form.elements.inverterEfficiency.value) / 100;
      const batteryAh = energyKwh > 0 && inverterEfficiency > 0 && inverterEfficiency <= 1 ? batteryCapacityAh({
        dailyEnergyWh: energyKwh * 1000 / inverterEfficiency,
        days: parseLocalizedNumber(form.elements.days.value),
        systemVoltage: parseLocalizedNumber(form.elements.voltage.value),
        dod: parseLocalizedNumber(form.elements.dod.value) / 100,
        temperatureFactor: parseLocalizedNumber(form.elements.derating.value) / 100,
      }) : null;
      if (batteryOutput) batteryOutput.textContent = batteryAh ? `${Math.ceil(batteryAh)} А·ч` : 'Заполните поля';

      const periodMode = periodField.value || 'year';
      const selectedMonth = parseLocalizedNumber(form.elements.solarMonth.value);
      const selectedMonths = periodMode === 'month' && Number.isInteger(selectedMonth) && selectedMonth >= 0 && selectedMonth < MONTH_COUNT
        ? [selectedMonth]
        : periodMode === 'summer' ? [4, 5, 6, 7] : periodMode === 'year' ? Array.from({ length: MONTH_COUNT }, (_, index) => index) : [];
      const panelFieldsValid = ['panelPower', 'panelLength', 'panelWidth']
        .every(name => form.elements[name].value !== '' && form.elements[name].validity.valid);
      const panelPowerW = parseLocalizedNumber(form.elements.panelPower.value);
      const panelEstimate = energyKwh > 0 && activePlaneIrradiance && selectedMonths.length
        && panelFieldsValid
        ? window.SolarResource?.recommendArray({
          dailyEnergyKwh: energyKwh,
          planeIrradiance: activePlaneIrradiance,
          panelPowerW,
          panelLengthMm: parseLocalizedNumber(form.elements.panelLength.value),
          panelWidthMm: parseLocalizedNumber(form.elements.panelWidth.value),
          months: selectedMonths,
        })
        : null;

      document.querySelectorAll('[data-month-index]').forEach(monthCard => {
        const month = Number(monthCard.dataset.monthIndex);
        const resource = activePlaneIrradiance?.[month];
        const monthSizing = energyKwh > 0 && panelFieldsValid
          ? window.SolarResource?.panelSizingForMonth({ dailyEnergyKwh: energyKwh, planeIrradiance: resource, panelPowerW })
          : null;
        const countOutput = monthCard.querySelector('[data-month-panels]');
        if (countOutput) {
          countOutput.textContent = monthSizing
            ? `${monthSizing.panelCount} шт.`
            : resource === 0 ? 'панелей: нет ресурса' : 'панелей: —';
        }
        monthCard.classList.toggle('is-selected-period', periodMode !== 'year' && selectedMonths.includes(month));
      });

      if (periodNotice) {
        periodNotice.hidden = periodMode === 'year';
        if (periodMode === 'month' && Number.isInteger(selectedMonth) && selectedMonth >= 0 && selectedMonth < MONTH_COUNT) {
          const selectedMonthResource = activePlaneIrradiance?.[selectedMonth];
          periodNotice.textContent = Number.isFinite(selectedMonthResource) && selectedMonthResource > 0
            ? `Выбран месяц: ${MONTH_NAMES[selectedMonth]}. Результат относится к среднему дню месяца; для зимней эксплуатации при той же нагрузке потребуется резервный источник или расчёт на весь год.`
            : `Для выбранного месяца (${MONTH_NAMES[selectedMonth]}) нет расчётного солнечного ресурса. Проверьте доступность данных сетки.`;
        } else if (periodMode === 'summer') {
          periodNotice.textContent = panelEstimate
            ? `Расчёт выполнен для сезона май–август, по самому слабому месяцу — ${MONTH_NAMES[panelEstimate.designMonth]}. Для зимней эксплуатации при той же нагрузке потребуется резервный источник или расчёт на весь год.`
            : 'Сезонный расчёт недоступен: проверьте нагрузку, панель и наличие данных за все месяцы сезона.';
        } else if (periodMode === 'month') {
          periodNotice.textContent = 'Выберите месяц для расчёта.';
        }
      }

      if (panelEstimate) {
        if (designMonthOutput) designMonthOutput.textContent = MONTH_LABELS[panelEstimate.designMonth];
        if (panelCountOutput) panelCountOutput.textContent = `${panelEstimate.panelCount} шт.`;
        if (panelPowerOutput) panelPowerOutput.textContent = `${panelEstimate.installedPowerKw.toFixed(2)} кВтп`;
        if (panelAreaOutput) panelAreaOutput.textContent = `${panelEstimate.moduleAreaM2.toFixed(2)} м²`;
      } else {
        const validSelectedMonths = activePlaneIrradiance && selectedMonths.length
          && selectedMonths.every(month => Number.isFinite(activePlaneIrradiance[month]));
        const weakestSelectedMonth = validSelectedMonths
          ? selectedMonths.reduce((weakest, month) => activePlaneIrradiance[month] < activePlaneIrradiance[weakest] ? month : weakest)
          : null;
        if (designMonthOutput) designMonthOutput.textContent = weakestSelectedMonth === null ? 'Нет данных' : MONTH_LABELS[weakestSelectedMonth];
        if (panelCountOutput) {
          if (!activePlaneIrradiance) panelCountOutput.textContent = 'Сначала выберите город и загрузите сетку';
          else if (!selectedMonths.length) panelCountOutput.textContent = 'Выберите месяц расчёта';
          else if (!validSelectedMonths) panelCountOutput.textContent = 'Нет данных сетки за выбранный период';
          else if (selectedMonths.some(month => activePlaneIrradiance[month] <= 0)) panelCountOutput.textContent = 'Нет солнечного ресурса в выбранном периоде';
          else if (!(energyKwh > 0) || !panelFieldsValid) panelCountOutput.textContent = 'Заполните нагрузку и паспорт панели';
          else panelCountOutput.textContent = 'Не удалось выполнить расчёт';
        }
        if (panelPowerOutput) panelPowerOutput.textContent = '—';
        if (panelAreaOutput) panelAreaOutput.textContent = '—';
      }

      const state = Object.fromEntries([...form.querySelectorAll('[name]')].map(field => [field.name, field.value]));
      state.consumers = consumers;
      try { localStorage.setItem(storageKey, JSON.stringify(state)); } catch {}
    }

    document.getElementById('addConsumer')?.addEventListener('click', () => { addConsumer(); update(); });
    form.addEventListener('submit', event => {
      event.preventDefault();
      update();
      document.querySelector('.calc-results')?.scrollIntoView({ behavior: 'auto', block: 'start' });
    });
    list.addEventListener('click', event => {
      if (!event.target.closest('.remove-consumer')) return;
      if (list.children.length > 1) event.target.closest('.consumer-row').remove();
      update();
    });
    form.addEventListener('input', update);
    form.addEventListener('change', update);
    periodField.addEventListener('change', syncPeriodControls);
    window.addEventListener('solar:profile-updated', update);
    const cityField = document.getElementById('city');
    const latitudeField = document.getElementById('latitude');
    const longitudeField = document.getElementById('longitude');
    let lastCityValue = cityField?.value.trim() || '';
    cityField?.addEventListener('input', () => {
      const nextCityValue = cityField.value.trim();
      if (nextCityValue !== lastCityValue) {
        if (latitudeField) latitudeField.value = '';
        if (longitudeField) longitudeField.value = '';
        lastCityValue = nextCityValue;
      }
      update();
      updateCityLocation(nextCityValue);
    });
    cityField?.addEventListener('change', () => updateCityLocation(cityField.value.trim()));
    async function updateCoordinateProfile() {
      const value = cityField?.value.trim();
      if (!value) return;
      try {
        const places = await loadCityPlaces();
        if (cityField.value.trim() !== value) return;
        const selected = cityOptions.get(value);
        const matches = selected ? [selected] : findExactCity(value, places);
        if (matches.length === 1) renderLocationAtCoordinates(matches[0], latitudeField, longitudeField);
      } catch {
        // City lookup reports its own loading error.
      }
    }
    latitudeField?.addEventListener('input', updateCoordinateProfile);
    longitudeField?.addEventListener('input', updateCoordinateProfile);
    update();
    if (cityField?.value.trim()) updateCityLocation(cityField.value.trim());
  }

  async function loadGrid(url = 'grid.bin') {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 8000);
    try {
      const response = await fetch(url, { signal: controller.signal });
      if (!response.ok) throw new Error(`Grid request failed: ${response.status}`);
      return parseGrid(await response.arrayBuffer());
    } finally {
      clearTimeout(timeout);
    }
  }

  async function initializeGrid() {
    const status = document.getElementById('gridStatus');
    try {
      activeGrid = await loadGrid();
      if (status) {
        status.classList.add('ready');
        status.textContent = `Солнечная сетка подключена: ${(activeGrid.rows * activeGrid.columns).toLocaleString('ru-RU')} точек, шаг ${activeGrid.step}°.`;
      }
      window.dispatchEvent(new CustomEvent('solar:grid-ready', { detail: { grid: activeGrid } }));
      const city = document.getElementById('city')?.value.trim();
      if (city) updateCityLocation(city);
      return activeGrid;
    } catch {
      if (status) {
        status.classList.remove('ready');
        status.textContent = 'Данные солнечной сетки не загружены.';
        status.hidden = false;
      }
      window.dispatchEvent(new CustomEvent('solar:grid-missing'));
      return null;
    }
  }

  window.SolarCalculator = Object.freeze({
    parseGrid,
    sampleMonthlyKt,
    dailyConsumptionKwh,
    batteryCapacityAh,
    loadGrid,
    loadCityPlaces,
    initializeGrid,
  });

  initializeForm();
  initializeGrid();
})();

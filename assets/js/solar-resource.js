(() => {
  'use strict';

  const MONTH_DAYS = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  const SOLAR_CONSTANT_W_M2 = 1361;
  const GROUND_ALBEDO = 0.2;
  const LOSS_FACTOR = 0.75;

  function clamp(value, min, max) {
    return Math.min(max, Math.max(min, value));
  }

  function monthMidpointDay(month) {
    return MONTH_DAYS.slice(0, month).reduce((sum, days) => sum + days, 0)
      + Math.floor(MONTH_DAYS[month] / 2);
  }

  function solarDeclination(dayOfYear) {
    const gamma = 2 * Math.PI * (dayOfYear - 1) / 365;
    return 0.006918
      - 0.399912 * Math.cos(gamma) + 0.070257 * Math.sin(gamma)
      - 0.006758 * Math.cos(2 * gamma) + 0.000907 * Math.sin(2 * gamma)
      - 0.002697 * Math.cos(3 * gamma) + 0.00148 * Math.sin(3 * gamma);
  }

  function sunsetAngle(latitude, declination) {
    const argument = -Math.tan(latitude) * Math.tan(declination);
    if (argument >= 1) return 0;
    if (argument <= -1) return Math.PI;
    return Math.acos(argument);
  }

  function extraterrestrialDailyIrradiance(latitude, month) {
    const day = monthMidpointDay(month);
    const gamma = 2 * Math.PI * (day - 1) / 365;
    const declination = solarDeclination(day);
    const distanceFactor = 1.00011 + 0.034221 * Math.cos(gamma) + 0.00128 * Math.sin(gamma)
      + 0.000719 * Math.cos(2 * gamma) + 0.000077 * Math.sin(2 * gamma);
    const sunset = sunsetAngle(latitude, declination);
    if (sunset === 0) return { value: 0, declination, sunset };
    const bracket = Math.cos(latitude) * Math.cos(declination) * Math.sin(sunset)
      + sunset * Math.sin(latitude) * Math.sin(declination);
    const value = (86400 * SOLAR_CONSTANT_W_M2 / Math.PI) * distanceFactor * Math.max(0, bracket) / 3.6e6;
    return { value, declination, sunset };
  }

  function diffuseFractionFromKt(kt) {
    if (kt <= 0.22) return 1 - 0.09 * kt;
    if (kt <= 0.8) {
      return clamp(0.9511 - 0.1604 * kt + 4.388 * kt ** 2 - 16.638 * kt ** 3 + 12.336 * kt ** 4, 0, 1);
    }
    return 0.165;
  }

  function monthlyPlaneIrradiance(ktProfile, latitudeDegrees) {
    if (!Array.isArray(ktProfile) || ktProfile.length !== 12 || !Number.isFinite(latitudeDegrees)
      || latitudeDegrees < -90 || latitudeDegrees > 90) return null;

    const latitude = latitudeDegrees * Math.PI / 180;
    const tilt = Math.abs(latitude);
    const effectiveLatitude = latitude - Math.sign(latitude || 1) * tilt;
    const cosineTilt = Math.cos(tilt);

    return ktProfile.map((kt, month) => {
      if (!Number.isFinite(kt) || kt < 0 || kt > 1.2) return null;
      const horizontalExtraterrestrial = extraterrestrialDailyIrradiance(latitude, month);
      if (horizontalExtraterrestrial.value === 0) return 0;

      const horizontalGlobal = kt * horizontalExtraterrestrial.value;
      const diffuseFraction = diffuseFractionFromKt(kt);
      const horizontalDiffuse = horizontalGlobal * diffuseFraction;
      const horizontalBeam = horizontalGlobal - horizontalDiffuse;

      const planeSunset = sunsetAngle(effectiveLatitude, horizontalExtraterrestrial.declination);
      const horizontalDenominator = Math.cos(latitude) * Math.cos(horizontalExtraterrestrial.declination)
        * Math.sin(horizontalExtraterrestrial.sunset)
        + horizontalExtraterrestrial.sunset * Math.sin(latitude) * Math.sin(horizontalExtraterrestrial.declination);
      const planeDenominator = Math.cos(effectiveLatitude) * Math.cos(horizontalExtraterrestrial.declination)
        * Math.sin(planeSunset)
        + planeSunset * Math.sin(effectiveLatitude) * Math.sin(horizontalExtraterrestrial.declination);
      const beamRatio = horizontalDenominator > 1e-9
        ? Math.max(0, planeDenominator / horizontalDenominator)
        : 0;

      const planeDiffuse = horizontalDiffuse * (1 + cosineTilt) / 2;
      const groundReflected = horizontalGlobal * GROUND_ALBEDO * (1 - cosineTilt) / 2;
      return Math.max(0, horizontalBeam * beamRatio + planeDiffuse + groundReflected);
    });
  }

  function panelSizingForMonth({ dailyEnergyKwh, planeIrradiance, panelPowerW }) {
    if (![dailyEnergyKwh, planeIrradiance, panelPowerW].every(Number.isFinite)
      || dailyEnergyKwh <= 0 || planeIrradiance <= 0 || panelPowerW <= 0) return null;
    const requiredArrayPowerKw = dailyEnergyKwh / (planeIrradiance * LOSS_FACTOR);
    const panelCount = Math.ceil(requiredArrayPowerKw * 1000 / panelPowerW);
    return {
      requiredArrayPowerKw,
      panelCount,
      installedPowerKw: panelCount * panelPowerW / 1000,
    };
  }

  function recommendArray({ dailyEnergyKwh, planeIrradiance, panelPowerW, panelLengthMm, panelWidthMm, months = Array.from({ length: 12 }, (_, index) => index) }) {
    const inputs = [dailyEnergyKwh, panelPowerW, panelLengthMm, panelWidthMm];
    if (!inputs.every(Number.isFinite) || inputs.some(value => value <= 0)
      || !Array.isArray(planeIrradiance) || planeIrradiance.length !== 12
      || !Array.isArray(months) || months.length === 0
      || months.some(month => !Number.isInteger(month) || month < 0 || month >= 12)
      || new Set(months).size !== months.length
      || months.some(month => !Number.isFinite(planeIrradiance[month]) || planeIrradiance[month] <= 0)) return null;

    let designMonth = months[0];
    for (const month of months.slice(1)) {
      if (planeIrradiance[month] < planeIrradiance[designMonth]) designMonth = month;
    }
    const sizing = panelSizingForMonth({ dailyEnergyKwh, planeIrradiance: planeIrradiance[designMonth], panelPowerW });
    if (!sizing) return null;
    return {
      designMonth,
      planeIrradiance: planeIrradiance[designMonth],
      requiredArrayPowerKw: sizing.requiredArrayPowerKw,
      panelCount: sizing.panelCount,
      installedPowerKw: sizing.installedPowerKw,
      moduleAreaM2: sizing.panelCount * panelLengthMm * panelWidthMm / 1e6,
      lossFactor: LOSS_FACTOR,
    };
  }

  window.SolarResource = Object.freeze({
    monthlyPlaneIrradiance,
    panelSizingForMonth,
    recommendArray,
    diffuseFractionFromKt,
    extraterrestrialDailyIrradiance,
  });
})();

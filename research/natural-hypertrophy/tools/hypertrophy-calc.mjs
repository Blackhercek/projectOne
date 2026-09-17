#!/usr/bin/env node
/**
 * Калькулятор плана натурального набора мышечной массы.
 *
 * Реализует расчётные модели из исследования ../README.md:
 *  - BMR: Mifflin-St Jeor (по весу) либо Katch-McArdle (по сухой массе, если известен %жира)
 *  - TDEE: BMR x коэффициент активности
 *  - Профицит и целевой темп набора: по тренировочному стажу
 *  - Макросы: белок -> жиры -> углеводы остатком
 *  - FFMI, e1RM, фактический TDEE по динамике веса
 *
 * Зависимости: нет. Требует Node.js >= 18.
 *
 * Использование:
 *   node hypertrophy-calc.mjs --sex=m --age=28 --height=180 --weight=75 \
 *                             --bodyfat=15 --activity=moderate --level=intermediate
 *   node hypertrophy-calc.mjs tdee  --kcal=2800 --days=14 --start=75.0 --end=75.6
 *   node hypertrophy-calc.mjs e1rm  --weight=100 --reps=8 --rir=2
 *   node hypertrophy-calc.mjs ffmi  --weight=75 --height=180 --bodyfat=15
 */

const KCAL_PER_KG_TISSUE = 7700;
const KCAL_PER_G = Object.freeze({ protein: 4, fat: 9, carb: 4 });

const ACTIVITY_FACTORS = Object.freeze({
  sedentary: 1.2,
  light: 1.375,
  moderate: 1.55,
  high: 1.725,
  athlete: 1.9,
});

/**
 * Профили по тренировочному стажу.
 * surplus — доля профицита от TDEE; gainRate — целевой прирост, % массы тела в неделю.
 */
const LEVEL_PROFILES = Object.freeze({
  beginner: {
    label: 'Новичок (< 1 года)',
    surplus: [0.10, 0.15],
    gainRate: [0.0025, 0.005],
    weeklySets: [10, 14],
    annualLeanGainKg: { m: [9, 11], f: [4.5, 5.5] },
  },
  intermediate: {
    label: 'Средний (1–3 года)',
    surplus: [0.08, 0.12],
    gainRate: [0.001, 0.0025],
    weeklySets: [12, 18],
    annualLeanGainKg: { m: [4, 5], f: [2, 2.5] },
  },
  advanced: {
    label: 'Опытный (3+ года)',
    surplus: [0.05, 0.08],
    gainRate: [0.0005, 0.0015],
    weeklySets: [14, 22],
    annualLeanGainKg: { m: [0.5, 1.5], f: [0.5, 1] },
  },
});

/** Доля сухой массы в приросте при соблюдении целевого темпа (Barakat/Slater, консервативно). */
const LEAN_FRACTION = 0.72;

// ---------------------------------------------------------------------------
// Чистые расчётные функции
// ---------------------------------------------------------------------------

/**
 * Базовый обмен по Mifflin-St Jeor.
 * @param {{sex:'m'|'f', weightKg:number, heightCm:number, age:number}} p
 * @returns {number} ккал/сутки
 */
export function bmrMifflin({ sex, weightKg, heightCm, age }) {
  const base = 10 * weightKg + 6.25 * heightCm - 5 * age;
  return sex === 'm' ? base + 5 : base - 161;
}

/**
 * Базовый обмен по Katch-McArdle (точнее при известном % жира).
 * @param {number} leanMassKg сухая масса, кг
 * @returns {number} ккал/сутки
 */
export function bmrKatch(leanMassKg) {
  return 370 + 21.6 * leanMassKg;
}

/**
 * Сухая масса тела.
 * @param {number} weightKg
 * @param {number} bodyFatPct
 * @returns {number}
 */
export function leanMass(weightKg, bodyFatPct) {
  return weightKg * (1 - bodyFatPct / 100);
}

/**
 * Fat-Free Mass Index с нормализацией на рост 1.8 м.
 * @param {{weightKg:number, heightCm:number, bodyFatPct:number}} p
 * @returns {number}
 */
export function ffmi({ weightKg, heightCm, bodyFatPct }) {
  const h = heightCm / 100;
  return leanMass(weightKg, bodyFatPct) / h ** 2 + 6.1 * (1.8 - h);
}

/**
 * Оценка одноповторного максимума.
 * @param {{weight:number, reps:number, rir?:number, formula?:'epley'|'brzycki'}} p
 * @returns {number} кг
 */
export function estimate1RM({ weight, reps, rir = 0, formula = 'epley' }) {
  const effectiveReps = reps + rir;
  if (formula === 'brzycki') {
    if (effectiveReps >= 37) throw new RangeError('Формула Бжицки неприменима при 37+ повторах');
    return (weight * 36) / (37 - effectiveReps);
  }
  return weight * (1 + effectiveReps / 30);
}

/**
 * Фактический TDEE по реальной динамике веса — точнее любой формулы.
 * @param {{avgKcal:number, days:number, startKg:number, endKg:number}} p
 * @returns {number} ккал/сутки
 */
export function actualTdee({ avgKcal, days, startKg, endKg }) {
  const deltaKg = endKg - startKg;
  return avgKcal - (deltaKg * KCAL_PER_KG_TISSUE) / days;
}

/**
 * Разбивка макронутриентов: белок -> жиры -> углеводы остатком.
 * @param {{kcal:number, weightKg:number, proteinPerKg:number, fatPctOfKcal:number}} p
 */
export function macros({ kcal, weightKg, proteinPerKg, fatPctOfKcal }) {
  const proteinG = Math.round(weightKg * proteinPerKg);
  const proteinKcal = proteinG * KCAL_PER_G.protein;

  const fatKcal = kcal * fatPctOfKcal;
  const fatG = Math.round(fatKcal / KCAL_PER_G.fat);

  const carbKcal = kcal - proteinKcal - fatG * KCAL_PER_G.fat;
  const carbG = Math.round(carbKcal / KCAL_PER_G.carb);

  if (carbG < 0) {
    throw new RangeError(
      'Отрицательные углеводы: белок и жиры превышают калорийность. Снизьте --protein или --fat-pct.',
    );
  }
  return { proteinG, fatG, carbG, proteinKcal, fatKcal: fatG * KCAL_PER_G.fat, carbKcal: carbG * KCAL_PER_G.carb };
}

/**
 * Прогноз массы и состава прироста при соблюдении целевого темпа.
 *
 * Важно: прирост сухой массы ограничен физиологическим потолком для данного
 * тренировочного стажа. Без этого ограничения модель выдаёт заведомо
 * невозможные числа на длинных горизонтах — темп веса масштабируется линейно,
 * а способность синтезировать мышечную ткань — нет.
 *
 * @param {{weightKg:number, weeklyRatePct:number, weeks:number, annualLeanCapKg:number}} p
 */
export function project({ weightKg, weeklyRatePct, weeks, annualLeanCapKg }) {
  // Темп задан в % от текущей массы -> экспоненциальный рост.
  const finalWeight = weightKg * (1 + weeklyRatePct) ** weeks;
  const totalGain = finalWeight - weightKg;

  const leanCap = annualLeanCapKg * (weeks / 52);
  const uncappedLean = totalGain * LEAN_FRACTION;
  const leanGain = Math.min(uncappedLean, leanCap);

  return {
    weeks,
    finalWeight,
    totalGain,
    leanGain,
    fatGain: totalGain - leanGain,
    cappedByPhysiology: uncappedLean > leanCap,
  };
}

// ---------------------------------------------------------------------------
// CLI: разбор аргументов и валидация
// ---------------------------------------------------------------------------

/** @param {string[]} argv @returns {{command:string, flags:Record<string,string|boolean>}} */
function parseArgs(argv) {
  const [first, ...rest] = argv;
  const isCommand = first !== undefined && !first.startsWith('--');
  const command = isCommand ? first : 'plan';
  const tokens = isCommand ? rest : argv;

  const flags = {};
  for (const token of tokens) {
    if (!token.startsWith('--')) throw new Error(`Не понял аргумент: "${token}". Ожидался формат --ключ=значение`);
    const [key, value] = token.slice(2).split('=');
    flags[key] = value === undefined ? true : value;
  }
  return { command, flags };
}

/** Числовой флаг с проверкой диапазона. */
function num(flags, key, { min = -Infinity, max = Infinity, required = true, fallback } = {}) {
  const raw = flags[key];
  if (raw === undefined || raw === true) {
    if (required) throw new Error(`Не задан обязательный параметр --${key}`);
    return fallback;
  }
  const value = Number(raw);
  if (!Number.isFinite(value)) throw new Error(`--${key}: "${raw}" не является числом`);
  if (value < min || value > max) throw new Error(`--${key}=${value} вне допустимого диапазона [${min}, ${max}]`);
  return value;
}

/** Строковый флаг из фиксированного набора. */
function choice(flags, key, allowed, fallback) {
  const raw = flags[key];
  if (raw === undefined || raw === true) {
    if (fallback !== undefined) return fallback;
    throw new Error(`Не задан обязательный параметр --${key} (варианты: ${allowed.join(', ')})`);
  }
  if (!allowed.includes(raw)) throw new Error(`--${key}=${raw}: допустимо только ${allowed.join(', ')}`);
  return raw;
}

const fmt = (n, digits = 0) => n.toLocaleString('ru-RU', { minimumFractionDigits: digits, maximumFractionDigits: digits });
const line = (char = '─', width = 62) => char.repeat(width);
const heading = (text) => `\n${text}\n${line()}`;

// ---------------------------------------------------------------------------
// Команды
// ---------------------------------------------------------------------------

function commandPlan(flags) {
  const sex = choice(flags, 'sex', ['m', 'f']);
  const age = num(flags, 'age', { min: 14, max: 100 });
  const heightCm = num(flags, 'height', { min: 120, max: 230 });
  const weightKg = num(flags, 'weight', { min: 30, max: 250 });
  const bodyFatPct = num(flags, 'bodyfat', { min: 3, max: 60, required: false });
  const activity = choice(flags, 'activity', Object.keys(ACTIVITY_FACTORS), 'moderate');
  const level = choice(flags, 'level', Object.keys(LEVEL_PROFILES), 'beginner');
  const proteinPerKg = num(flags, 'protein', { min: 1.2, max: 3.5, required: false, fallback: 2.0 });
  const fatPctOfKcal = num(flags, 'fat-pct', { min: 15, max: 40, required: false, fallback: 25 }) / 100;
  const meals = num(flags, 'meals', { min: 2, max: 8, required: false, fallback: 4 });

  const profile = LEVEL_PROFILES[level];
  const activityFactor = ACTIVITY_FACTORS[activity];

  const bmr = bodyFatPct !== undefined
    ? bmrKatch(leanMass(weightKg, bodyFatPct))
    : bmrMifflin({ sex, weightKg, heightCm, age });
  const bmrSource = bodyFatPct !== undefined ? 'Katch-McArdle (по сухой массе)' : 'Mifflin-St Jeor';
  const tdee = bmr * activityFactor;

  const [surplusLow, surplusHigh] = profile.surplus;
  const targetKcal = Math.round(tdee * (1 + (surplusLow + surplusHigh) / 2));
  const [rateLow, rateHigh] = profile.gainRate;
  const rateMid = (rateLow + rateHigh) / 2;

  const m = macros({ kcal: targetKcal, weightKg, proteinPerKg, fatPctOfKcal });

  const out = [];
  out.push(heading('ИСХОДНЫЕ ДАННЫЕ'));
  out.push(`  Пол/возраст:        ${sex === 'm' ? 'мужчина' : 'женщина'}, ${age} лет`);
  out.push(`  Рост/вес:           ${fmt(heightCm)} см / ${fmt(weightKg, 1)} кг`);
  if (bodyFatPct !== undefined) {
    out.push(`  Жир / сухая масса:  ${fmt(bodyFatPct, 1)} % / ${fmt(leanMass(weightKg, bodyFatPct), 1)} кг`);
    out.push(`  FFMI:               ${fmt(ffmi({ weightKg, heightCm, bodyFatPct }), 1)}`);
  }
  out.push(`  Активность:         ${activity} (x${activityFactor})`);
  out.push(`  Уровень:            ${profile.label}`);

  out.push(heading('ЭНЕРГИЯ'));
  out.push(`  BMR:                ${fmt(bmr)} ккал   [${bmrSource}]`);
  out.push(`  TDEE (расчётный):   ${fmt(tdee)} ккал`);
  out.push(`  Профицит:           +${fmt(surplusLow * 100)}…${fmt(surplusHigh * 100)} %`);
  out.push(`  ЦЕЛЬ:               ${fmt(targetKcal)} ккал/сутки`);
  out.push('');
  out.push('  ! Это гипотеза. Через 2 недели пересчитайте по факту:');
  out.push('    node hypertrophy-calc.mjs tdee --kcal=... --days=14 --start=... --end=...');

  out.push(heading('МАКРОНУТРИЕНТЫ'));
  out.push(`  Белок:              ${fmt(m.proteinG)} г  (${proteinPerKg} г/кг, ${fmt(m.proteinKcal)} ккал)`);
  out.push(`  Жиры:               ${fmt(m.fatG)} г  (${fmt(fatPctOfKcal * 100)} % ккал, ${fmt(m.fatKcal)} ккал)`);
  out.push(`  Углеводы:           ${fmt(m.carbG)} г  (${fmt(m.carbG / weightKg, 1)} г/кг, ${fmt(m.carbKcal)} ккал)`);
  out.push('');
  out.push(`  Распределение белка: ${meals} приёма по ${fmt(m.proteinG / meals)} г`);

  const perMealPerKg = m.proteinG / meals / weightKg;
  let mealVerdict;
  if (perMealPerKg < 0.4) mealVerdict = '— ниже цели: поднимите белок или уменьшите число приёмов';
  else if (perMealPerKg > 0.55) mealVerdict = '— выше цели: разнесите на большее число приёмов';
  else mealVerdict = '✓';
  out.push(`  (${fmt(perMealPerKg, 2)} г/кг на приём — цель 0.40–0.55 ${mealVerdict})`);

  const carbPerKg = m.carbG / weightKg;
  if (carbPerKg < 3) {
    out.push('');
    out.push(`  ! Углеводы ${fmt(carbPerKg, 1)} г/кг — ниже рекомендованных 4–7 г/кг для массонабора.`);
    out.push('    Снизьте --protein или --fat-pct: в объёмных блоках это бьёт по работоспособности.');
  }

  out.push(heading('ТЕМП НАБОРА'));
  out.push(`  Целевой темп:       ${fmt(rateLow * 100, 2)}…${fmt(rateHigh * 100, 2)} % массы тела в неделю`);
  out.push(`  В граммах:          ${fmt(weightKg * rateLow * 1000)}…${fmt(weightKg * rateHigh * 1000)} г/неделю`);
  out.push(`  Контроль:           скользящее среднее веса за 7 дней, не разовое взвешивание`);

  const [annualLow, annualHigh] = profile.annualLeanGainKg[sex];
  const annualLeanCapKg = (annualLow + annualHigh) / 2;

  out.push(heading('ПРОГНОЗ (при соблюдении среднего темпа)'));
  out.push('  Срок      Вес       Всего     Мышцы     Жир');
  let anyCapped = false;
  for (const weeks of [12, 24, 52]) {
    const p = project({ weightKg, weeklyRatePct: rateMid, weeks, annualLeanCapKg });
    anyCapped ||= p.cappedByPhysiology;
    out.push(
      `  ${String(weeks + ' нед').padEnd(10)}${(fmt(p.finalWeight, 1) + ' кг').padEnd(10)}` +
      `${('+' + fmt(p.totalGain, 1)).padEnd(10)}${('+' + fmt(p.leanGain, 1)).padEnd(10)}` +
      `+${fmt(p.fatGain, 1)}${p.cappedByPhysiology ? '   <- упёрлись в потолок' : ''}`,
    );
  }
  out.push('');
  out.push(`  Физиологический потолок сухой массы: ${annualLow}–${annualHigh} кг/год для вашего уровня.`);
  if (anyCapped) {
    out.push('  Помеченные строки: темп веса выше того, что может стать мышцами.');
    out.push('  Избыток уходит в жир. Практический вывод — не держать профицит');
    out.push('  круглый год: набор 16–24 нед -> мини-сушка 6–10 нед -> новый блок.');
  } else {
    out.push('  Темп согласован с потолком: весь профицит обеспечен стимулом.');
  }

  out.push(heading('ТРЕНИРОВОЧНЫЙ ОБЪЁМ'));
  const [setsLow, setsHigh] = profile.weeklySets;
  out.push(`  Стартовый объём:    ${setsLow}–${setsHigh} рабочих подходов на мышцу в неделю`);
  out.push(`  Частота:            2 раза в неделю на каждую мышечную группу`);
  out.push(`  Близость к отказу:  RIR 0–3 (изоляция ближе, тяжёлая база дальше)`);
  out.push(`  Прогрессия:         двойная (повторы -> вес), лог обязателен`);

  out.push(heading('СЛЕДУЮЩИЕ ШАГИ'));
  out.push('  1. Программа:  ../04-program.md');
  out.push('  2. Питание:    ../05-nutrition.md');
  out.push('  3. Лог и аудит: ../08-tracking.md');
  out.push('');

  return out.join('\n');
}

function commandTdee(flags) {
  const avgKcal = num(flags, 'kcal', { min: 800, max: 8000 });
  const days = num(flags, 'days', { min: 7, max: 120 });
  const startKg = num(flags, 'start', { min: 30, max: 250 });
  const endKg = num(flags, 'end', { min: 30, max: 250 });

  const tdee = actualTdee({ avgKcal, days, startKg, endKg });
  const deltaKg = endKg - startKg;
  const weeklyKg = (deltaKg / days) * 7;
  const weeklyPct = (weeklyKg / startKg) * 100;

  const out = [];
  out.push(heading('ФАКТИЧЕСКИЙ TDEE ПО ДИНАМИКЕ ВЕСА'));
  out.push(`  Период:             ${days} дн., средняя калорийность ${fmt(avgKcal)} ккал`);
  out.push(`  Вес:                ${fmt(startKg, 1)} -> ${fmt(endKg, 1)} кг (${deltaKg >= 0 ? '+' : ''}${fmt(deltaKg, 2)} кг)`);
  out.push(`  Темп:               ${weeklyKg >= 0 ? '+' : ''}${fmt(weeklyKg * 1000)} г/нед (${fmt(weeklyPct, 2)} % массы тела)`);
  out.push('');
  out.push(`  ФАКТИЧЕСКИЙ TDEE:   ${fmt(tdee)} ккал/сутки`);
  out.push('');
  if (weeklyPct < 0.1) out.push('  Диагноз: темп ниже целевого -> добавьте 150–250 ккал/день.');
  else if (weeklyPct > 0.5) out.push('  Диагноз: темп выше целевого -> уберите 150–250 ккал/день, проверьте талию.');
  else out.push('  Диагноз: темп в целевом диапазоне. Ничего не менять.');
  out.push('');
  return out.join('\n');
}

function commandE1rm(flags) {
  const weight = num(flags, 'weight', { min: 1, max: 600 });
  const reps = num(flags, 'reps', { min: 1, max: 40 });
  const rir = num(flags, 'rir', { min: 0, max: 10, required: false, fallback: 0 });

  const epley = estimate1RM({ weight, reps, rir, formula: 'epley' });
  const brzycki = reps + rir < 37 ? estimate1RM({ weight, reps, rir, formula: 'brzycki' }) : null;

  const out = [];
  out.push(heading('ОЦЕНКА 1ПМ'));
  out.push(`  Подход:             ${fmt(weight, 1)} кг x ${reps} повт. @ RIR ${rir}`);
  out.push(`  Эффективных повт.:  ${reps + rir}`);
  out.push('');
  out.push(`  Эпли:               ${fmt(epley, 1)} кг`);
  if (brzycki !== null) out.push(`  Бжицки:             ${fmt(brzycki, 1)} кг`);
  out.push('');
  out.push('  Рабочие веса от оценки по Эпли:');
  for (const pct of [0.6, 0.7, 0.75, 0.8, 0.85, 0.9]) {
    out.push(`    ${fmt(pct * 100)} %  ->  ${fmt(epley * pct, 1)} кг`);
  }
  out.push('');
  out.push('  Используйте ОДНУ формулу постоянно: важен тренд, а не абсолютная точность.');
  out.push('');
  return out.join('\n');
}

function commandFfmi(flags) {
  const weightKg = num(flags, 'weight', { min: 30, max: 250 });
  const heightCm = num(flags, 'height', { min: 120, max: 230 });
  const bodyFatPct = num(flags, 'bodyfat', { min: 3, max: 60 });
  const sex = choice(flags, 'sex', ['m', 'f'], 'm');

  const value = ffmi({ weightKg, heightCm, bodyFatPct });
  const ceiling = sex === 'm' ? 25 : 21.5;
  const remainingLean = (ceiling - value) * (heightCm / 100) ** 2;

  const out = [];
  out.push(heading('FFMI'));
  out.push(`  Сухая масса:        ${fmt(leanMass(weightKg, bodyFatPct), 1)} кг`);
  out.push(`  FFMI:               ${fmt(value, 1)}`);
  out.push(`  Ориентир потолка:   ~${ceiling} (${sex === 'm' ? 'мужчины' : 'женщины'})`);
  out.push('');
  if (remainingLean > 0) {
    out.push(`  Теоретический остаток до потолка: ~${fmt(remainingLean, 1)} кг сухой массы.`);
    out.push('');
    out.push('  Реалистичный график его набора (прирост убывает с каждым годом):');
    const yearlyCaps = sex === 'm' ? [10, 4.5, 2.25, 1, 1, 0.75, 0.75] : [5, 2.25, 1.25, 0.75, 0.75, 0.5, 0.5];
    let left = remainingLean;
    let years = 0;
    for (const cap of yearlyCaps) {
      if (left <= 0) break;
      years += 1;
      const gained = Math.min(cap, left);
      left -= gained;
      out.push(`    Год ${years}: +${fmt(gained, 2)} кг  (останется ${fmt(Math.max(0, left), 1)} кг)`);
    }
    if (left > 0) out.push(`    Далее: ещё ~${fmt(left / 0.6, 0)} лет по 0.5–0.75 кг/год`);
    out.push('');
    out.push('  Потолок ~25 — 97-й перцентиль выборки, а не гарантия. Большинство');
    out.push('  тренирующихся останавливается на 22–23 по причинам образа жизни.');
  } else {
    out.push('  Вы у верхней границы типичного натурального диапазона.');
    out.push('  Дальнейший прогресс измеряется сотнями граммов в год.');
  }
  out.push('');
  out.push('  Замечание: точность зависит от оценки % жира. Биоимпеданс даёт ±3–5 %,');
  out.push('  что соответствует ±1 пункту FFMI. Смотрите на тренд, не на абсолют.');
  out.push('');
  return out.join('\n');
}

function commandHelp() {
  return `
Калькулятор натурального набора мышечной массы

  node hypertrophy-calc.mjs [команда] [--флаги]

КОМАНДЫ
  plan (по умолчанию)   Полный расчёт: TDEE, калории, макросы, темп, прогноз, объём
  tdee                  Фактический TDEE по реальной динамике веса
  e1rm                  Оценка одноповторного максимума и рабочих весов
  ffmi                  Индекс сухой массы и остаточный потенциал
  help                  Эта справка

PLAN
  --sex=m|f             (обяз.) пол
  --age=28              (обяз.) возраст, лет
  --height=180          (обяз.) рост, см
  --weight=75           (обяз.) вес, кг
  --bodyfat=15          % жира — включает более точную формулу Katch-McArdle
  --activity=moderate   sedentary|light|moderate|high|athlete   [moderate]
  --level=intermediate  beginner|intermediate|advanced          [beginner]
  --protein=2.0         белок, г/кг                              [2.0]
  --fat-pct=25          доля жиров от калорийности, %            [25]
  --meals=4             число приёмов пищи                       [4]

TDEE
  --kcal=2800 --days=14 --start=75.0 --end=75.6

E1RM
  --weight=100 --reps=8 [--rir=2]

FFMI
  --weight=75 --height=180 --bodyfat=15 [--sex=m]

ПРИМЕР
  node hypertrophy-calc.mjs --sex=m --age=28 --height=180 --weight=75 \\
       --bodyfat=15 --activity=moderate --level=intermediate
`;
}

// ---------------------------------------------------------------------------
// Точка входа
// ---------------------------------------------------------------------------

const COMMANDS = { plan: commandPlan, tdee: commandTdee, e1rm: commandE1rm, ffmi: commandFfmi };

function main(argv) {
  let parsed;
  try {
    parsed = parseArgs(argv);
  } catch (error) {
    console.error(`Ошибка: ${error.message}`);
    console.error(commandHelp());
    process.exitCode = 1;
    return;
  }

  const { command, flags } = parsed;

  if (command === 'help' || flags.help || argv.length === 0) {
    console.log(commandHelp());
    return;
  }

  const handler = COMMANDS[command];
  if (!handler) {
    console.error(`Ошибка: неизвестная команда "${command}". Доступны: ${Object.keys(COMMANDS).join(', ')}, help`);
    process.exitCode = 1;
    return;
  }

  try {
    console.log(handler(flags));
  } catch (error) {
    console.error(`Ошибка: ${error.message}`);
    process.exitCode = 1;
  }
}

// Запуск только при прямом вызове — модуль остаётся импортируемым для тестов.
if (import.meta.url === `file://${process.argv[1]}`) {
  main(process.argv.slice(2));
}

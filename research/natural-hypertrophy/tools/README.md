# tools — расчётные инструменты

## hypertrophy-calc.mjs

Калькулятор плана натурального набора массы. Node.js ≥ 18, без зависимостей.

```bash
# Полный план: TDEE, калории, макросы, темп, прогноз, объём
node hypertrophy-calc.mjs --sex=m --age=28 --height=180 --weight=75 \
     --bodyfat=15 --activity=moderate --level=intermediate

# Фактический TDEE по реальной динамике веса (важнее любой формулы)
node hypertrophy-calc.mjs tdee --kcal=2800 --days=14 --start=75.0 --end=75.6

# Оценка 1ПМ и рабочих весов
node hypertrophy-calc.mjs e1rm --weight=100 --reps=8 --rir=2

# FFMI и остаточный потенциал
node hypertrophy-calc.mjs ffmi --weight=75 --height=180 --bodyfat=15

# Справка
node hypertrophy-calc.mjs help
```

### Модели внутри

| Расчёт | Модель |
|---|---|
| BMR | Mifflin–St Jeor; Katch–McArdle при известном % жира |
| TDEE | BMR × коэффициент активности (1.2–1.9) |
| Профицит | +5–15 % от TDEE по тренировочному стажу |
| Темп набора | 0.25–0.5 % / 0.1–0.25 % / 0.05–0.15 % массы тела в неделю |
| Макросы | Белок → жиры (% ккал) → углеводы остатком |
| Прогноз | Экспоненциальный рост веса, **прирост мышц ограничен физиологическим потолком** |
| e1RM | Эпли и Бжицки, с поправкой на RIR |
| FFMI | С нормализацией на рост 1.8 м |

Функции экспортируются как ES-модуль — их можно импортировать:

```js
import { estimate1RM, actualTdee, ffmi } from './hypertrophy-calc.mjs';
```

## Шаблоны логов

- `training-log-template.csv` — лог тренировок (вес × повторы × RIR по подходам)
- `body-log-template.csv` — ежедневный лог тела (вес, обхваты, сон, калории)

Импортируются в Google Sheets / Excel как есть.

---

← [К оглавлению исследования](../README.md)

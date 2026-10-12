"use strict";

(() => {
  // Содержимое приложения. Предустановки становятся обычными блоками дня.
  const STORAGE_KEY = "moy-den.state.v1";
  const ROUTINE_PRESETS = [
    { title: "Завтрак", kind: "rest", legacy: { enabled: true, start: null, durationMinutes: 30 }, weekday: { enabled: true, start: 480, durationMinutes: 30 }, weekend: { enabled: true, start: 660, durationMinutes: 30 } },
    { title: "Обед", kind: "rest", legacy: { enabled: true, start: null, durationMinutes: 30 }, weekday: { enabled: true, start: 780, durationMinutes: 30 }, weekend: { enabled: true, start: 900, durationMinutes: 30 } },
    { title: "Сборы Ромы в школу", kind: "work", legacy: { enabled: false, start: null, durationMinutes: null }, weekday: { enabled: true, start: 405, durationMinutes: 45 }, weekend: { enabled: false, start: null, durationMinutes: null } }
  ];
  const QUOTES = Object.freeze([
    "Сегодня можно двигаться в своём темпе.",
    "Один небольшой шаг уже заслуживает внимания.",
    "В вашем дне есть место и делам, и отдыху.",
    "Начните с того, что сейчас кажется посильным.",
    "Пауза помогает бережнее относиться к себе.",
    "Вы можете оставить время для самого важного.",
    "Не всё нужно успеть именно сегодня.",
    "Ваш собственный ритм достоин уважения.",
    "Небольшое дело тоже может быть важным.",
    "В план можно вносить изменения по ходу дня.",
    "Забота о себе тоже занимает место в плане.",
    "Можно сделать паузу и выбрать следующий шаг.",
    "У каждого дела есть подходящее для него время.",
    "Сегодня достаточно начать с одного дела.",
    "Оставьте немного пространства для неожиданного.",
    "Вы можете выбирать, чему уделить внимание.",
    "Спокойный темп помогает замечать сделанное.",
    "День не обязан быть заполнен до последней минуты.",
    "Можно бережно пересмотреть свои ожидания.",
    "Отдых не требует специального повода.",
    "Ваш план может подстраиваться под вашу жизнь.",
    "Каждое завершённое дело можно заметить.",
    "Сегодня есть место для простых решений.",
    "Можно выбрать главное и оставить остальное на потом.",
    "Небольшая передышка тоже часть вашего дня.",
    "Вы можете начать заново с текущего момента.",
    "Свой день можно выстраивать постепенно.",
    "Понятный следующий шаг помогает начать.",
    "Внимание к своим силам помогает выбирать дела.",
    "Можно отметить сделанное и немного отдохнуть.",
    "Пусть в сегодняшнем плане будет место для вас."
  ]);
  const clone = value => JSON.parse(JSON.stringify(value));
  let idCounter = 0;

  // TimeUtils: чистые функции, без DOM и хранилища.
  const TimeUtils = Object.freeze({
    dateKey(date = new Date()) {
      return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
    },
    validDate(value) {
      if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
      const [y, m, d] = value.split("-").map(Number);
      const check = new Date(0);
      check.setUTCFullYear(y, m - 1, d);
      return check.getUTCFullYear() === y && check.getUTCMonth() === m - 1 && check.getUTCDate() === d;
    },
    parseTime(value) {
      if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(value)) return null;
      const [h, m] = value.split(":").map(Number);
      return h * 60 + m;
    },
    time(value) {
      return value === null ? "" : `${String(Math.floor(value / 60)).padStart(2, "0")}:${String(value % 60).padStart(2, "0")}`;
    },
    humanDate(key) {
      const [y, m, d] = key.split("-").map(Number);
      return new Date(y, m - 1, d).toLocaleDateString("ru-RU", { day: "numeric", month: "long", year: "numeric" });
    },
    isWeekend(key) {
      const weekday = new Date(`${key}T12:00:00`).getDay();
      return weekday === 0 || weekday === 6;
    },
    quote(date = new Date()) {
      const n = Math.floor(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()) / 86400000);
      return QUOTES[((n % QUOTES.length) + QUOTES.length) % QUOTES.length];
    },
    search(value) { return value.trim().toLocaleLowerCase("ru-RU").replaceAll("ё", "е"); },
    completed(task) { return task.progress.reduce((sum, part) => sum + part.minutes, 0); },
    remaining(task) { return task.durationMinutes - TimeUtils.completed(task); }
  });

  // StateValidator: общие инварианты проверяются и при чтении, и перед записью.
  const StateValidator = Object.freeze({
    validate(state) {
      let path = "state";
      const fail = message => { throw new Error(`${path}: ${message}`); };
      const object = x => x !== null && typeof x === "object" && !Array.isArray(x);
      const integer = (x, min, max = Number.MAX_SAFE_INTEGER) => Number.isSafeInteger(x) && x >= min && x <= max;
      const minute = x => x === null || integer(x, 0, 1439);
      const title = x => typeof x === "string" && x === x.trim() && x.length >= 1 && x.length <= 200;
      const iso = x => typeof x === "string" && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(x) && Number.isFinite(Date.parse(x)) && new Date(x).toISOString() === x;
      const identifier = x => typeof x === "string" && x.length > 0 && !["__proto__", "constructor", "prototype"].includes(x);
      const ids = new Set(), progressOwners = new Map(), completionOwners = new Map();
      const field = (name, valid, message) => { if (!valid) { path += `.${name}`; fail(message); } };
      const unique = id => { if (!identifier(id) || ids.has(id)) fail("Повторяющийся или неверный идентификатор."); ids.add(id); };
      const progress = (parts, owner) => {
        if (!Array.isArray(parts)) fail("Неверная история выполнения.");
        const events = new Set();
        for (const p of parts) {
          if (!object(p) || !identifier(p.eventId) || events.has(p.eventId) || !integer(p.minutes, 1, 1440) || !iso(p.completedAt) || !minute(p.plannedStart) || !minute(p.plannedEnd)) fail("Неверная часть выполнения.");
          if (progressOwners.has(p.eventId) && progressOwners.get(p.eventId) !== owner) fail("Идентификатор части выполнения повторяется у разных задач.");
          progressOwners.set(p.eventId, owner);
          if ((p.plannedStart === null) !== (p.plannedEnd === null) || (p.plannedStart !== null && p.plannedEnd <= p.plannedStart)) fail("Неверный интервал части.");
          if (p.plannedIntervals !== undefined && (!Array.isArray(p.plannedIntervals) || !p.plannedIntervals.every(i => object(i) && integer(i.start, 0, 1439) && integer(i.end, 0, 1439) && i.end > i.start) || p.plannedIntervals.reduce((sum, i) => sum + i.end - i.start, 0) > p.minutes)) fail("Неверные плановые интервалы выполнения.");
          events.add(p.eventId);
        }
        return parts.reduce((sum, p) => sum + p.minutes, 0);
      };
      if (object(state) && state.schemaVersion !== 1) { path = "state.schemaVersion"; fail("Неподдерживаемая версия состояния."); }
      if (object(state)) {
        field("revision", integer(state.revision, 0), "Нужно неотрицательное целое число.");
        field("nextSequence", integer(state.nextSequence, 0), "Нужно неотрицательное целое число.");
        field("updatedAt", iso(state.updatedAt), "Нужна корректная ISO-дата.");
        for (const name of ["tasks", "days", "backlog", "ui"]) field(name, object(state[name]), "Нужен объект.");
        field("ui.unfinishedOpen", typeof state.ui.unfinishedOpen === "boolean", "Нужно логическое значение.");
      }
      if (!object(state) || state.schemaVersion !== 1 || !integer(state.revision, 0) || !integer(state.nextSequence, 0) || !iso(state.updatedAt) || !object(state.tasks) || !object(state.days) || !object(state.backlog) || !object(state.ui) || typeof state.ui.unfinishedOpen !== "boolean") fail("Неверная структура состояния.");
      if (Object.keys(state.tasks).length > 10000) { path = "state.tasks"; fail("Допустимо не более 10 000 задач."); }
      if (Object.keys(state.days).length > 3660) { path = "state.days"; fail("Допустимо не более 3660 дней."); }
      const references = new Map();
      const list = (container, category, location, date) => {
        path = `${location === "backlog" ? "state.backlog" : `state.days.${date}`}.${category}Ids`;
        const arr = container[`${category}Ids`];
        if (!Array.isArray(arr)) fail("Неверный список задач.");
        for (const id of arr) {
          if (references.has(id)) fail("Задача находится в нескольких списках.");
          const t = state.tasks[id];
          if (!object(t) || t.status !== "active" || t.location !== location || t.planDate !== date || t.category !== category) fail("Потерянная ссылка или неверный раздел задачи.");
          references.set(id, true);
        }
      };
      list(state.backlog, "main", "backlog", null);
      list(state.backlog, "small", "backlog", null);
      for (const [key, day] of Object.entries(state.days)) {
        path = `state.days.${key}`;
        if (object(day)) {
          field("date", TimeUtils.validDate(key) && day.date === key, "Нужна существующая календарная дата, совпадающая с ключом дня.");
          field("start", minute(day.start), "Нужно null или целое число 0–1439.");
          field("end", minute(day.end) && (day.start === null || day.end === null || day.end > day.start), "Нужно null или время после начала дня, в пределах 0–1439.");
          field("defaultBreakMinutes", integer(day.defaultBreakMinutes, 0, 180), "Нужно целое число 0–180.");
          field("routines", Array.isArray(day.routines), "Нужен массив бытовых блоков.");
          field("completionEvents", Array.isArray(day.completionEvents), "Нужен массив событий выполнения.");
        }
        if (!TimeUtils.validDate(key) || !object(day) || day.date !== key || !minute(day.start) || !minute(day.end) || (day.start !== null && day.end !== null && day.end <= day.start) || !integer(day.defaultBreakMinutes, 0, 180) || !(day.presetVersion === undefined || day.presetVersion === 2) || !Array.isArray(day.routines) || !Array.isArray(day.completionEvents)) fail("Неверные настройки дня.");
        list(day, "main", "day", key); list(day, "small", "day", key);
        for (const r of day.routines) {
          path = `state.days.${key}.routines.${r?.id ?? "unknown"}`;
          if (!object(r)) fail("Неверный бытовой блок.");
          unique(r.id);
          field("title", title(r.title), "Нужно название длиной 1–200 символов без пробелов по краям.");
          field("enabled", typeof r.enabled === "boolean", "Нужно логическое значение.");
          field("kind", ["work", "rest"].includes(r.kind), "Допустимы work и rest.");
          field("start", minute(r.start), "Нужно null или целое число 0–1439.");
          field("durationMinutes", (r.durationMinutes === null || integer(r.durationMinutes, 1, 1440)) && (r.start === null || r.durationMinutes === null || r.start + r.durationMinutes <= 1439), "Нужно null или целое число 1–1440, блок должен закончиться в пределах дня.");
          field("breakOverride", r.breakOverride === null || integer(r.breakOverride, 0, 180), "Нужно null или целое число 0–180.");
          if (!title(r.title) || typeof r.enabled !== "boolean" || !["work", "rest"].includes(r.kind) || !minute(r.start) || !(r.durationMinutes === null || integer(r.durationMinutes, 1, 1440)) || !(r.breakOverride === null || integer(r.breakOverride, 0, 180)) || (r.start !== null && r.durationMinutes !== null && r.start + r.durationMinutes > 1439)) fail("Неверные поля бытового блока.");
        }
        for (const e of day.completionEvents) {
          path = `state.days.${key}.completionEvents.${e?.id ?? "unknown"}`;
          if (!object(e)) fail("Неверное событие выполнения.");
          unique(e.id);
          completionOwners.set(e.id, e.taskId);
          field("taskId", e.taskId === null || Object.hasOwn(state.tasks, e.taskId), "Ссылка на существующую задачу или null.");
          field("at", iso(e.at), "Нужна корректная ISO-дата.");
          field("sequence", integer(e.sequence, 1, state.nextSequence), "Нужен номер 1–nextSequence.");
          field("confirmedMinutes", integer(e.confirmedMinutes, 1, 1440), "Нужно целое число 1–1440.");
          field("breakAfterMinutes", integer(e.breakAfterMinutes, 0, 180), "Нужно целое число 0–180.");
          field("cancelled", typeof e.cancelled === "boolean", "Нужно логическое значение.");
          if (!(e.taskId === null || Object.hasOwn(state.tasks, e.taskId)) || !iso(e.at) || !integer(e.sequence, 1, state.nextSequence) || !integer(e.confirmedMinutes, 1, 1440) || !integer(e.breakAfterMinutes, 0, 180) || typeof e.cancelled !== "boolean") fail("Неверные поля события выполнения.");
          if (e.sourceKey !== undefined && (typeof e.sourceKey !== "string" || !/^task:.+:part:[1-9]\d*$/.test(e.sourceKey))) fail("Неверный источник события выполнения.");
        }
      }
      for (const [id, t] of Object.entries(state.tasks)) {
        path = `state.tasks.${id}`;
        if (!object(t) || id !== t.id) fail("Неверная запись задачи.");
        if (!integer(t.durationMinutes, 1, 1440)) { path += ".durationMinutes"; fail("Длительность должна быть целым числом 1–1440."); }
        unique(id);
        field("title", title(t.title), "Нужно название длиной 1–200 символов без пробелов по краям.");
        field("category", ["main", "small"].includes(t.category), "Допустимы main и small.");
        field("mode", ["flexible", "fixed"].includes(t.mode), "Допустимы flexible и fixed.");
        field("createdAt", iso(t.createdAt), "Нужна корректная ISO-дата.");
        field("updatedAt", iso(t.updatedAt), "Нужна корректная ISO-дата.");
        field("breakOverrides", object(t.breakOverrides) && Object.entries(t.breakOverrides).every(([key, value]) => /^[1-9]\d*$/.test(key) && integer(value, 0, 180)), "Нужен объект номеров частей с перерывами 0–180.");
        if (!title(t.title) || !["main", "small"].includes(t.category) || !["flexible", "fixed"].includes(t.mode) || !integer(t.durationMinutes, 1, 1440) || !iso(t.createdAt) || !iso(t.updatedAt) || !object(t.breakOverrides) || !Object.entries(t.breakOverrides).every(([key, value]) => /^[1-9]\d*$/.test(key) && integer(value, 0, 180))) fail("Неверные поля задачи.");
        if (t.mode === "flexible" ? t.fixedStart !== null || t.fixedEnd !== null : !integer(t.fixedStart, 0, 1439) || !integer(t.fixedEnd, 0, 1439) || t.fixedEnd <= t.fixedStart || t.durationMinutes !== t.fixedEnd - t.fixedStart) fail("Неверное время задачи.");
        const done = progress(t.progress, id);
        if (t.status === "active") {
          if (!references.has(id) || !["day", "backlog"].includes(t.location) || done >= t.durationMinutes || t.archivedAt !== null || t.archiveSequence !== null || t.returnState !== null) fail("Неверное состояние активной задачи.");
        } else if (t.status === "archived") {
          const r = t.returnState;
          if (references.has(id) || t.location !== "archive" || done !== t.durationMinutes || !iso(t.archivedAt) || !integer(t.archiveSequence, 1, state.nextSequence) || !object(r) || !["day", "backlog"].includes(r.location) || r.category !== t.category || !integer(r.index, 0) || !(r.previousId === null || identifier(r.previousId)) || !(r.nextId === null || identifier(r.nextId)) || !identifier(r.terminalEventId)) fail("Неверное состояние архивной задачи.");
          if (r.planDate !== t.planDate || (r.location === "backlog" ? r.planDate !== null : !TimeUtils.validDate(r.planDate) || !Object.hasOwn(state.days, r.planDate))) fail("Неверный источник архива.");
          if (progress(r.progress, id) >= t.durationMinutes || t.progress.length !== r.progress.length + 1 || JSON.stringify(t.progress.slice(0, -1)) !== JSON.stringify(r.progress) || t.progress.at(-1).eventId !== r.terminalEventId) fail("Неверный снимок восстановления.");
        } else fail("Неизвестный статус задачи.");
      }
      for (const [eventId, owner] of progressOwners) {
        if (ids.has(eventId) && completionOwners.get(eventId) !== owner) { path = `state.tasks.${owner}.progress`; fail("Идентификатор части совпадает с другой сущностью или с событием другой задачи."); }
      }
      return true;
    }
  });

  // TaskActions: операции над переданной рабочей копией, без DOM/localStorage.
  const TaskActions = Object.freeze({
    newId(state, prefix) {
      const occupied = new Set(Object.keys(state.tasks));
      for (const day of Object.values(state.days)) {
        day.routines.forEach(r => occupied.add(r.id));
        day.completionEvents.forEach(e => occupied.add(e.id));
      }
      Object.values(state.tasks).forEach(t => t.progress.forEach(p => occupied.add(p.eventId)));
      let id;
      do { id = `${prefix}-${Date.now().toString(36)}-${(++idCounter).toString(36)}-${Math.random().toString(36).slice(2, 8)}`; } while (occupied.has(id));
      return id;
    },
    emptyState(now = new Date()) {
      return { schemaVersion: 1, revision: 0, nextSequence: 0, updatedAt: now.toISOString(), tasks: {}, days: {}, backlog: { mainIds: [], smallIds: [] }, ui: { unfinishedOpen: false } };
    },
    ensureDay(state, date) {
      const variant = TimeUtils.isWeekend(date) ? "weekend" : "weekday";
      if (!Object.hasOwn(state.days, date)) {
        const day = { date, start: null, end: null, defaultBreakMinutes: 10, mainIds: [], smallIds: [], routines: [], completionEvents: [], presetVersion: 2 };
        state.days[date] = day;
        day.routines = ROUTINE_PRESETS.map(p => ({ id: TaskActions.newId(state, "routine"), title: p.title, kind: p.kind, ...p[variant], breakOverride: null }));
      } else if (state.days[date].presetVersion === undefined) {
        // Однократное обновление только нетронутых старых предустановок.
        // Заданные вручную часы, выключенные приёмы пищи и удалённые строки сохраняются.
        const day = state.days[date];
        for (const p of ROUTINE_PRESETS) {
          const r = day.routines.find(r => r.title === p.title && r.kind === p.kind && r.breakOverride === null && Object.entries(p.legacy).every(([key, value]) => r[key] === value));
          if (r) Object.assign(r, p[variant]);
        }
        day.presetVersion = 2;
      }
      return state.days[date];
    },
    dayProgress(state, date) {
      const day = state.days[date];
      const completed = Object.values(state.tasks).filter(t => t.status === "archived" && t.planDate === date && t.returnState.location === "day" && TimeUtils.dateKey(new Date(t.archivedAt)) === date).length;
      const total = day.mainIds.length + day.smallIds.length + completed;
      return { completed, total, percent: total ? Math.round(completed / total * 100) : 0 };
    },
    sourceList(state, task) {
      const container = task.location === "backlog" ? state.backlog : state.days[task.planDate];
      return container[`${task.category}Ids`];
    },
    move(state, id, location, category, date, index = null) {
      const task = state.tasks[id];
      if (!task || task.status !== "active") throw new Error("Задача больше не активна.");
      const source = TaskActions.sourceList(state, task);
      source.splice(source.indexOf(id), 1);
      task.location = location; task.category = category; task.planDate = location === "day" ? date : null;
      if (location === "day") TaskActions.ensureDay(state, date);
      const target = TaskActions.sourceList(state, task);
      target.splice(index === null ? target.length : Math.max(0, Math.min(index, target.length)), 0, id);
      task.updatedAt = new Date().toISOString();
    },
    saveTask(state, id, fields, date) {
      if (id) {
        const task = state.tasks[id];
        if (!task || task.status !== "active") throw new Error("Задача больше не активна.");
        if (task.location !== fields.location || task.category !== fields.category || fields.location === "day" && task.planDate !== date) TaskActions.move(state, id, fields.location, fields.category, date);
        Object.assign(task, fields, { updatedAt: new Date().toISOString() });
        return id;
      }
      const newId = TaskActions.newId(state, "task"), stamp = new Date().toISOString();
      const task = { id: newId, ...fields, status: "active", planDate: fields.location === "day" ? date : null, createdAt: stamp, updatedAt: stamp, progress: [], archivedAt: null, archiveSequence: null, returnState: null, breakOverrides: {} };
      state.tasks[newId] = task;
      if (task.location === "day") TaskActions.ensureDay(state, date);
      TaskActions.sourceList(state, task).push(newId);
      return newId;
    },
    confirmWork(state, id, today, now, minutes, options = {}) {
      const task = state.tasks[id];
      if (!task || task.status !== "active") throw new Error("Задача уже завершена или удалена.");
      if (!Number.isInteger(minutes) || minutes <= 0 || minutes > TimeUtils.remaining(task)) throw new Error("Объём выполнения больше оставшейся работы.");
      const source = TaskActions.sourceList(state, task), index = source.indexOf(id);
      const eventId = TaskActions.newId(state, "event"), stamp = now.toISOString();
      const sequence = ++state.nextSequence, terminal = minutes === TimeUtils.remaining(task);
      if (terminal) task.returnState = { location: task.location, planDate: task.planDate, category: task.category, index, previousId: source[index - 1] ?? null, nextId: source[index + 1] ?? null, progress: clone(task.progress), terminalEventId: eventId };
      const record = { eventId, minutes, completedAt: stamp, plannedStart: options.plannedStart ?? (task.mode === "fixed" ? task.fixedStart : null), plannedEnd: options.plannedEnd ?? (task.mode === "fixed" ? task.fixedEnd : null) };
      if (options.plannedIntervals) record.plannedIntervals = clone(options.plannedIntervals);
      task.progress.push(record);
      if (task.location === "day" && task.planDate === today) {
        state.days[today].completionEvents.push({ id: eventId, taskId: id, at: stamp, sequence, confirmedMinutes: minutes, breakAfterMinutes: options.breakMinutes ?? task.breakOverrides["1"] ?? state.days[today].defaultBreakMinutes, sourceKey: options.sourceKey ?? `task:${id}:part:1`, cancelled: false });
      }
      task.updatedAt = stamp;
      if (terminal) {
        source.splice(index, 1);
        Object.assign(task, { status: "archived", location: "archive", archivedAt: stamp, archiveSequence: sequence });
      }
      return { eventId, archived: terminal };
    },
    complete(state, id, today, now = new Date(), options = {}) {
      return TaskActions.confirmWork(state, id, today, now, TimeUtils.remaining(state.tasks[id]), options);
    },
    completePart(state, id, part, today, now = new Date()) {
      const task = state.tasks[id];
      if (!task || task.mode !== "flexible" || task.location !== "day" || task.planDate !== today) throw new Error("Эта часть больше не относится к сегодняшнему плану.");
      return TaskActions.confirmWork(state, id, today, now, part.end - part.start, { plannedStart: part.start, plannedEnd: part.end, breakMinutes: part.breakMinutes, sourceKey: part.sourceKey });
    },
    undoPart(state, id, eventId) {
      const task = state.tasks[id];
      if (!task) throw new Error("Задача удалена.");
      if (task.status === "archived" && task.returnState.terminalEventId === eventId) return TaskActions.restore(state, id);
      if (task.status !== "active" || task.progress.at(-1)?.eventId !== eventId) throw new Error("Можно отменить только последнее выполнение этой задачи.");
      task.progress.pop(); task.updatedAt = new Date().toISOString();
      for (const day of Object.values(state.days)) for (const e of day.completionEvents) if (e.id === eventId) e.cancelled = true;
    },
    setBreak(state, date, source, minutes) {
      if (!Number.isInteger(minutes) || minutes < 0 || minutes > 180) throw new Error("Перерыв — целое число от 0 до 180 минут.");
      if (source.type === "task") {
        if (!state.tasks[source.id]) throw new Error("Задача удалена.");
        state.tasks[source.id].breakOverrides[String(source.partNumber)] = minutes;
      } else if (source.type === "block") {
        const block = state.days[date].routines.find(r => r.id === source.id);
        if (!block) throw new Error("Блок удалён.");
        block.breakOverride = minutes;
      } else {
        const event = state.days[date].completionEvents.find(e => e.id === source.id && !e.cancelled);
        if (!event) throw new Error("Это выполнение уже отменено.");
        event.breakAfterMinutes = minutes;
      }
    },
    restore(state, id) {
      const task = state.tasks[id];
      if (!task || task.status !== "archived") throw new Error("Задача уже восстановлена или удалена.");
      const r = task.returnState;
      for (const day of Object.values(state.days)) for (const e of day.completionEvents) if (e.id === r.terminalEventId) e.cancelled = true;
      Object.assign(task, { status: "active", location: r.location, planDate: r.planDate, category: r.category, progress: clone(r.progress), archivedAt: null, archiveSequence: null, returnState: null, updatedAt: new Date().toISOString() });
      const target = TaskActions.sourceList(state, task);
      const next = target.indexOf(r.nextId), previous = target.indexOf(r.previousId);
      target.splice(next >= 0 ? next : previous >= 0 ? previous + 1 : Math.min(r.index, target.length), 0, id);
      return { location: task.location, date: task.planDate };
    },
    deleteTask(state, id) {
      const task = state.tasks[id];
      if (!task) return;
      if (task.status === "active") {
        const source = TaskActions.sourceList(state, task); source.splice(source.indexOf(id), 1);
      }
      for (const day of Object.values(state.days)) for (const e of day.completionEvents) if (e.taskId === id) e.taskId = null;
      delete state.tasks[id];
    },
    lastCompletion(state) {
      const events = new Map(Object.values(state.days).flatMap(d => d.completionEvents).map(e => [e.id, e.sequence]));
      return Object.values(state.tasks).filter(t => t.progress.length).map(t => ({ taskId: t.id, title: t.title, ...t.progress.at(-1), sequence: t.archiveSequence ?? events.get(t.progress.at(-1).eventId) ?? 0 })).sort((a, b) => b.completedAt.localeCompare(a.completedAt) || b.sequence - a.sequence || b.eventId.localeCompare(a.eventId))[0] ?? null;
    },
    archived(state) {
      return Object.values(state.tasks).filter(t => t.status === "archived").sort((a, b) => b.archivedAt.localeCompare(a.archivedAt) || b.archiveSequence - a.archiveSequence);
    }
  });

  // PlannerEngine: расчёт с явным временем. Не изменяет вход и не обращается к UI.
  const PlannerEngine = (() => {
    function union(intervals) {
      const result = [];
      for (const item of intervals.filter(i => i.end > i.start).map(i => ({ start: i.start, end: i.end })).sort((a, b) => a.start - b.start || a.end - b.end)) {
        const last = result.at(-1);
        if (last && item.start <= last.end) last.end = Math.max(last.end, item.end);
        else result.push(item);
      }
      return result;
    }
    function subtract(start, end, occupied) {
      let cursor = start; const result = [];
      for (const item of union(occupied)) {
        if (item.end <= cursor) continue;
        if (item.start >= end) break;
        if (item.start > cursor) result.push({ start: cursor, end: Math.min(item.start, end) });
        cursor = Math.max(cursor, item.end);
        if (cursor >= end) break;
      }
      if (cursor < end) result.push({ start: cursor, end });
      return result;
    }
    function calculate(state, now, date = TimeUtils.dateKey(now)) {
      const day = state.days[date];
      const result = { date, calculatedAt: now.toISOString(), start: day?.start ?? null, end: day?.end ?? null, boundary: null, intervals: [], warnings: [], tasks: {}, breakSources: {}, summary: null, status: "Укажите границы дня" };
      const warn = (code, text, refs = [], controlKey = null) => result.warnings.push({ code, text, refs, controlKey });
      if (!day || day.start === null || day.end === null || day.end <= day.start) {
        warn("DAY_INCOMPLETE", "Укажите корректное начало и окончание дня"); return result;
      }
      const rawNow = now.getHours() * 60 + now.getMinutes() + now.getSeconds() / 60 + now.getMilliseconds() / 60000;
      const boundary = Math.max(day.start, Math.ceil(rawNow)); result.boundary = boundary;
      const ordered = [...day.mainIds, ...day.smallIds].map(id => state.tasks[id]);
      const queue = ordered.filter(t => t.mode === "flexible").map(t => ({ task: t, left: TimeUtils.remaining(t), parts: [] }));
      queue.forEach(q => { result.tasks[q.task.id] = { remaining: q.left, unplaced: q.left, parts: q.parts }; });
      const fixed = [];
      const register = (key, value) => { result.breakSources[key] = value; return key; };
      for (const t of ordered.filter(t => t.mode === "fixed")) {
        const key = `task:${t.id}:part:1`, rest = t.breakOverrides["1"] ?? day.defaultBreakMinutes;
        register(key, { type: "task", id: t.id, partNumber: 1, title: t.title, minutes: rest });
        fixed.push({ id: `fixed:${t.id}`, type: "task", taskId: t.id, title: t.title, kind: "work", mode: "fixed", start: t.fixedStart, end: t.fixedEnd, partNumber: 1, sourceKey: key, controlKey: key, breakMinutes: rest, refs: [{ type: "task", id: t.id }] });
        if (t.fixedEnd <= rawNow) warn("FIXED_MISSED", `Время задачи «${t.title}» прошло`, [{ type: "task", id: t.id }]);
      }
      for (const r of day.routines.filter(r => r.enabled)) {
        if (r.start === null || r.durationMinutes === null) { warn("BLOCK_INCOMPLETE", `Укажите время и длительность: «${r.title}»`, [{ type: "block", id: r.id }]); continue; }
        const key = `block:${r.id}:part:1`, rest = r.breakOverride ?? day.defaultBreakMinutes;
        if (r.kind === "work") register(key, { type: "block", id: r.id, partNumber: 1, title: r.title, minutes: rest });
        fixed.push({ id: `fixed:${r.id}`, type: "block", routineId: r.id, title: r.title, kind: r.kind, start: r.start, end: r.start + r.durationMinutes, partNumber: 1, sourceKey: key, controlKey: key, breakMinutes: r.kind === "work" ? rest : 0, refs: [{ type: "block", id: r.id }] });
      }
      fixed.sort((a, b) => a.start - b.start || a.end - b.end || (a.taskId ?? a.routineId).localeCompare(b.taskId ?? b.routineId));
      for (let i = 0; i < fixed.length; i++) {
        const item = fixed[i];
        if (item.start < day.start || item.end > day.end) warn("OUTSIDE_DAY", `«${item.title}» (${TimeUtils.time(item.start)}–${TimeUtils.time(item.end)}) ${item.start < day.start ? "начинается раньше начала дня" : ""}${item.start < day.start && item.end > day.end ? " и " : ""}${item.end > day.end ? "заканчивается позже конца дня" : ""}`, item.refs);
        for (let j = i + 1; j < fixed.length && fixed[j].start < item.end; j++) {
          const other = fixed[j], start = Math.max(item.start, other.start), end = Math.min(item.end, other.end);
          warn("FIXED_OVERLAP", `«${item.title}» и «${other.title}» пересекаются: ${TimeUtils.time(start)}–${TimeUtils.time(end)}`, [...item.refs, ...other.refs]);
          item.conflict = true; other.conflict = true;
        }
      }
      // Колонки назначаются внутри связной группы пересечений исходных интервалов.
      let group = [], groupEnd = -1;
      const assignColumns = () => {
        const ends = [];
        for (const item of group) {
          let index = ends.findIndex(end => end <= item.start); if (index < 0) index = ends.length;
          ends[index] = item.end; item.column = index;
        }
        group.forEach(item => { item.columns = Math.max(1, ends.length); });
      };
      for (const item of fixed) {
        if (group.length && item.start >= groupEnd) { assignColumns(); group = []; groupEnd = -1; }
        group.push(item); groupEnd = Math.max(groupEnd, item.end);
      }
      assignColumns();
      const occupied = [];
      for (const item of fixed) {
        const start = Math.max(day.start, item.start), end = Math.min(day.end, item.end);
        if (end <= start) continue;
        const last = occupied.at(-1);
        if (last && start < last.end) { last.end = Math.max(last.end, end); last.members.push(item); }
        else occupied.push({ start, end, members: [item] });
        result.intervals.push({ ...item, originalStart: item.start, originalEnd: item.end, start, end });
      }
      for (const item of occupied) {
        const work = item.members.filter(m => m.kind === "work").sort((a, b) => b.breakMinutes - a.breakMinutes || b.end - a.end || a.id.localeCompare(b.id));
        const source = work[0] ?? item.members.at(-1);
        Object.assign(item, { kind: work.length ? "work" : "rest", breakMinutes: work.length ? source.breakMinutes : 0, title: item.members.map(m => m.title).join(" / "), controlKey: source.controlKey, refs: item.members.flatMap(m => m.refs) });
      }
      const breaks = [];
      const addBreak = (source, start, end) => {
        for (const piece of subtract(Math.max(start, day.start), Math.min(end, day.end), [...occupied, ...breaks])) {
          const item = { id: `break:${source.controlKey}:${piece.start}-${piece.end}`, type: "break", title: "Перерыв", kind: "rest", ...piece, requiredMinutes: source.breakMinutes, controlKey: source.controlKey, sourceTitle: source.title };
          breaks.push(item); result.intervals.push(item);
        }
      };
      const events = day.completionEvents.filter(e => !e.cancelled).sort((a, b) => b.at.localeCompare(a.at) || b.sequence - a.sequence);
      const latest = events[0], furtherWork = queue.some(q => q.left > 0) || fixed.some(f => f.kind === "work" && f.end > boundary);
      let eventRestEnd = boundary;
      if (latest && furtherWork) {
        const at = new Date(latest.at), atMinute = at.getHours() * 60 + at.getMinutes() + at.getSeconds() / 60 + at.getMilliseconds() / 60000;
        const end = Math.ceil(atMinute + latest.breakAfterMinutes), key = `event:${latest.id}`;
        const title = state.tasks[latest.taskId]?.title ?? "Выполненная работа";
        register(key, { type: "event", id: latest.id, title, minutes: latest.breakAfterMinutes });
        if (latest.breakAfterMinutes === 0) warn("REST_MISSING", "Между задачами не предусмотрен отдых", latest.taskId ? [{ type: "task", id: latest.taskId }] : [], key);
        if (end > boundary) {
          eventRestEnd = end;
          addBreak({ controlKey: key, breakMinutes: latest.breakAfterMinutes, title }, Math.max(boundary, Math.ceil(atMinute)), end);
          for (const f of fixed.filter(f => f.kind === "work" && f.start < end && f.end > boundary)) warn("REST_NO_ROOM", `После «${title}» не помещается перерыв перед «${f.title}»: нужно ${latest.breakAfterMinutes} мин, доступно ${Math.max(0, f.start - Math.ceil(atMinute))} мин`, f.refs, key);
        }
      }
      const connect = (previous, next, endOfGap) => {
        if (!previous || previous.kind !== "work" || next.kind !== "work") return;
        const required = previous.breakMinutes, available = Math.max(0, endOfGap - previous.end);
        if (required === 0) warn("REST_MISSING", "Между задачами не предусмотрен отдых", previous.refs ?? [], previous.controlKey);
        else {
          addBreak(previous, previous.end, Math.min(previous.end + required, endOfGap));
          if (available < required) warn("REST_NO_ROOM", `Между «${previous.title}» и «${next.title}» не помещается перерыв: нужно ${required} мин, доступно ${available} мин`, [...(previous.refs ?? []), ...(next.refs ?? [])], previous.controlKey);
        }
      };
      let cursor = day.start, previous = null;
      const gaps = [...occupied, { start: day.end, end: day.end, kind: "end", title: "Конец дня" }];
      for (const right of gaps) {
        const gapEnd = right.start;
        let left = previous;
        if (gapEnd > boundary) {
          while (true) {
            const earliest = Math.max(cursor, boundary, eventRestEnd, left?.kind === "work" ? left.end + left.breakMinutes : cursor);
            let chosen = null, size = 0, partNumber = 0, rest = 0;
            for (const q of queue) {
              if (q.left <= 0) continue;
              const n = q.parts.length + 1, requested = q.task.breakOverrides[String(n)] ?? day.defaultBreakMinutes;
              const capacity = gapEnd - earliest - (right.kind === "work" ? requested : 0);
              if (capacity <= 0 || q.left > capacity && capacity < 15) continue;
              chosen = q; size = Math.min(q.left, capacity); partNumber = n; rest = requested; break;
            }
            if (!chosen) break;
            const key = `task:${chosen.task.id}:part:${partNumber}`;
            const part = { id: `${key}@${earliest}-${earliest + size}`, type: "task", taskId: chosen.task.id, title: chosen.task.title, mode: "flexible", kind: "work", start: earliest, end: earliest + size, partNumber, breakMinutes: rest, sourceKey: key, controlKey: key, refs: [{ type: "task", id: chosen.task.id }] };
            connect(left, part, part.start);
            register(key, { type: "task", id: chosen.task.id, partNumber, title: chosen.task.title, minutes: rest });
            chosen.parts.push(part); chosen.left -= size; result.intervals.push(part); left = part;
          }
        }
        if (right.kind === "work") connect(left, right, right.start);
        previous = right; cursor = right.end;
      }
      for (const q of queue) result.tasks[q.task.id].unplaced = q.left;
      const unplaced = queue.reduce((sum, q) => sum + q.left, 0);
      if (unplaced) warn("OVERLOAD", `План перегружен: не размещено ${unplaced} мин задач`, queue.filter(q => q.left > 0).map(q => ({ type: "task", id: q.task.id })));
      if (rawNow >= day.end && ordered.length) warn("DAY_ENDED", "Рабочий день завершён. Остались невыполненные задачи");
      // Свободные минуты — дополнение объединения интервалов, включая историю блоков.
      const occupiedMinutes = union(result.intervals);
      for (const free of subtract(day.start, day.end, occupiedMinutes)) {
        if (free.start < boundary) result.intervals.push({ id: `past:${free.start}`, type: "free", kind: "free", title: "До текущего расчёта", start: free.start, end: Math.min(free.end, boundary) });
        if (free.end > boundary) result.intervals.push({ id: `free:${Math.max(free.start, boundary)}`, type: "free", kind: "free", title: "Свободное время", start: Math.max(free.start, boundary), end: free.end });
      }
      const future = items => items.map(i => ({ start: Math.max(i.start, boundary), end: Math.min(i.end, day.end) })).filter(i => i.end > i.start);
      const length = items => union(items).reduce((sum, i) => sum + i.end - i.start, 0);
      const work = future(result.intervals.filter(i => i.kind === "work"));
      const rest = future(result.intervals.filter(i => i.kind === "rest"));
      const workMinutes = length(work), occupiedFuture = length([...work, ...rest]);
      const available = Math.max(0, day.end - boundary);
      result.summary = { dayMinutes: day.end - day.start, available, work: workMinutes, rest: occupiedFuture - workMinutes, unplaced, free: Math.max(0, available - occupiedFuture), missed: result.warnings.filter(w => w.code === "FIXED_MISSED").length };
      const rank = { DAY_INCOMPLETE: 0, BLOCK_INCOMPLETE: 1, FIXED_OVERLAP: 2, OUTSIDE_DAY: 3, FIXED_MISSED: 4, DAY_ENDED: 5, REST_MISSING: 6, REST_NO_ROOM: 7, OVERLOAD: 8 };
      result.warnings.sort((a, b) => rank[a.code] - rank[b.code]);
      result.intervals.sort((a, b) => a.start - b.start || a.end - b.end || a.id.localeCompare(b.id));
      result.status = result.warnings.some(w => w.code === "FIXED_OVERLAP") ? "Есть конфликты" : result.warnings.length ? "Проверьте план" : ordered.length ? "Всё помещается" : "Добавьте задачи";
      return result;
    }
    return Object.freeze({ calculate });
  })();

  // StateStore: проверяемые записи; импорт/очистка меняют память только после записи.
  const StateStore = (() => {
    const MiB = 1048576, limit = 4 * MiB;
    let state, error = "", blocked = false, saved = false, dirty = false, conflict = false, baseline = null, original = null, code = "";
    const estimate = value => 2 * (STORAGE_KEY.length + JSON.stringify(value).length);
    function failure(e) {
      saved = false; code = e.name === "QuotaExceededError" ? "STORAGE_LIMIT" : "STORAGE_FAILED";
      error = code === "STORAGE_LIMIT" ? "Недостаточно места для сохранения. Изменения остаются в памяти. Скачайте резервную копию или очистите старый архив." : "Изменения сейчас не сохраняются в браузере. Скачайте резервную копию.";
    }
    function load() {
      state = TaskActions.emptyState(); error = ""; blocked = false; saved = false; dirty = false; conflict = false; code = ""; original = null; baseline = null;
      try {
        original = baseline = localStorage.getItem(STORAGE_KEY);
        if (baseline !== null) {
          try { const parsed = JSON.parse(baseline); StateValidator.validate(parsed); state = parsed; saved = true; }
          catch (e) { blocked = true; error = "Сохранённые данные не удалось прочитать. Исходная запись не изменена."; code = "STORAGE_FAILED"; return state; }
        }
        try { localStorage.setItem("moy-den.storage-test", "1"); localStorage.removeItem("moy-den.storage-test"); }
        catch (e) { failure(e); }
      } catch (e) { failure(e); }
      return state;
    }
    function noticeExternal() { conflict = true; saved = false; error = "Данные изменились в другой вкладке. Загрузите актуальные данные перед продолжением; при необходимости сначала скачайте эту копию."; code = "STORAGE_CONFLICT"; }
    function externalChanged() {
      try { return localStorage.getItem(STORAGE_KEY) !== baseline; } catch { return false; }
    }
    function verifyFresh() {
      if (conflict || externalChanged()) { noticeExternal(); throw new Error(error); }
    }
    function write(candidate, allowBlocked = false) {
      if (blocked && !allowBlocked) throw new Error("Исходная повреждённая запись защищена");
      verifyFresh();
      if (estimate(candidate) > limit) { const e = new Error("Состояние превышает защитный предел 4 MiB"); e.name = "QuotaExceededError"; throw e; }
      const raw = JSON.stringify(candidate); localStorage.setItem(STORAGE_KEY, raw);
      baseline = raw; original = null; saved = true; dirty = false; blocked = false; error = ""; code = ""; conflict = false;
    }
    function transact(operation) {
      verifyFresh(); // Устаревшая вкладка не применяет даже локальную операцию.
      const candidate = clone(state), result = operation(candidate);
      StateValidator.validate(candidate);
      candidate.revision = state.revision + 1; candidate.updatedAt = new Date().toISOString();
      try { write(candidate); }
      catch (e) {
        if (conflict) throw e;
        candidate.revision = state.revision; candidate.updatedAt = state.updatedAt; dirty = true;
        if (!blocked) failure(e);
      }
      state = candidate; return result;
    }
    function replace(value) {
      verifyFresh(); const candidate = clone(value); StateValidator.validate(candidate);
      candidate.revision = Math.max(state.revision, candidate.revision) + 1; candidate.updatedAt = new Date().toISOString();
      try { write(candidate, true); } catch (e) { if (!conflict) failure(e); throw new Error(error); }
      state = candidate; return true;
    }
    function prepareDay(date) {
      if (state.days[date] && state.days[date].presetVersion === 2) return;
      try { transact(candidate => TaskActions.ensureDay(candidate, date)); }
      catch { const candidate = clone(state); TaskActions.ensureDay(candidate, date); StateValidator.validate(candidate); state = candidate; dirty = true; saved = false; }
    }
    return Object.freeze({ load, transact, replace, prepareDay, estimate, externalChanged, noticeExternal, raw: () => original ?? baseline, get: () => state,
      status: () => ({ saved, error, blocked, dirty, conflict, code, size: estimate(state), nearLimit: estimate(state) >= 3 * MiB }) });
  })();

  // BackupIO: JSON, предпросмотр и очищаемый кандидат. Никакой автоматической очистки.
  const BackupIO = Object.freeze({
    encode(state, now = new Date()) { StateValidator.validate(state); return JSON.stringify({ product: "moy-den", backupVersion: 1, exportedAt: now.toISOString(), state }, null, 2); },
    filename(now = new Date(), suffix = "json") { return `moy-den-backup-${TimeUtils.dateKey(now)}-${String(now.getHours()).padStart(2,"0")}-${String(now.getMinutes()).padStart(2,"0")}-${String(now.getSeconds()).padStart(2,"0")}.${suffix}`; },
    parse(text, bytes) {
      if (bytes > 8 * 1048576) throw new Error("file.size: файл больше 8 MiB. Лимит файла отличается от предела хранения.");
      let data; try { data = JSON.parse(text); } catch { throw new Error("file: некорректный JSON"); }
      if (!data || typeof data !== "object" || Array.isArray(data)) throw new Error("file: нужен объект резервной копии");
      if (data.product !== "moy-den") throw new Error("product: это не копия планировщика «Мой день»");
      if (data.backupVersion !== 1) throw new Error("backupVersion: неподдерживаемая версия копии");
      if (typeof data.exportedAt !== "string" || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(data.exportedAt) || !Number.isFinite(Date.parse(data.exportedAt)) || new Date(data.exportedAt).toISOString() !== data.exportedAt) throw new Error("exportedAt: неверная ISO-дата");
      StateValidator.validate(data.state);
      if (StateStore.estimate(data.state) > 4 * 1048576) throw new Error("state: превышен защитный предел хранения 4 MiB, даже если JSON-файл меньше 8 MiB");
      return clone(data.state);
    },
    counts(state) {
      const tasks = Object.values(state.tasks);
      return { active: tasks.filter(t => t.status === "active" && t.location === "day").length, backlog: tasks.filter(t => t.location === "backlog").length, archive: tasks.filter(t => t.status === "archived").length };
    },
    cleanup(state, cutoff, today = TimeUtils.dateKey()) {
      if (!TimeUtils.validDate(cutoff) || cutoff > today) throw new Error("Выберите корректную дату не позднее сегодня");
      const candidate = clone(state), removed = new Set(Object.values(state.tasks).filter(t => t.status === "archived" && TimeUtils.dateKey(new Date(t.archivedAt)) < cutoff).map(t => t.id));
      const titles = [...removed].map(id => state.tasks[id].title);
      removed.forEach(id => delete candidate.tasks[id]);
      const retainedEvents = new Set(), retainedDays = new Set();
      for (const t of Object.values(candidate.tasks)) {
        if (t.planDate) retainedDays.add(t.planDate);
        for (const p of [...t.progress, ...(t.returnState?.progress ?? [])]) { retainedEvents.add(p.eventId); retainedDays.add(TimeUtils.dateKey(new Date(p.completedAt))); }
        if (t.returnState?.terminalEventId) retainedEvents.add(t.returnState.terminalEventId);
      }
      let events = 0, days = 0;
      for (const [date, day] of Object.entries(candidate.days)) {
        day.completionEvents.forEach(e => { if (removed.has(e.taskId)) e.taskId = null; });
        if (date >= cutoff || date === today) continue;
        const before = day.completionEvents.length;
        day.completionEvents = day.completionEvents.filter(e => retainedEvents.has(e.id) || e.taskId !== null && Object.hasOwn(candidate.tasks, e.taskId));
        events += before - day.completionEvents.length;
        if (!retainedDays.has(date) && !day.mainIds.length && !day.smallIds.length && !day.completionEvents.length) { delete candidate.days[date]; days++; }
      }
      StateValidator.validate(candidate);
      return { candidate, titles, tasks: removed.size, events, days, freed: Math.max(0, StateStore.estimate(state) - StateStore.estimate(candidate)) };
    },
    download(text, filename, type = "application/json;charset=utf-8") {
      const url = URL.createObjectURL(new Blob([text], { type })), a = document.createElement("a");
      a.href = url; a.download = filename; document.body.append(a);
      try { a.click(); } finally { a.remove(); setTimeout(() => URL.revokeObjectURL(url), 1000); }
    }
  });

  // PlannerView: безопасное отображение. События передаются контроллеру.
  const PlannerView = (() => {
    const $ = id => document.getElementById(id);
    let selectedInterval = null, renderedDate = null;
    function node(tag, className, text) {
      const element = document.createElement(tag);
      if (className) element.className = className;
      if (text !== undefined) element.textContent = text;
      return element;
    }
    function action(label, name, id, className = "button-text") {
      const b = node("button", className, label); b.type = "button"; b.dataset.action = name;
      if (id) b.dataset.id = id;
      return b;
    }
    function tag(text, kind = "") { return node("span", `meta-tag ${kind}`, text); }
    function duration(task) { return TimeUtils.completed(task) ? `Осталось ${TimeUtils.remaining(task)} из ${task.durationMinutes} мин` : `${task.durationMinutes} мин`; }
    function card(task, highest, state, plan) {
      const c = $("task-card-template").content.firstElementChild.cloneNode(true); c.dataset.id = task.id;
      c.querySelector(".task-title").textContent = task.title;
      const meta = c.querySelector(".task-meta");
      meta.append(tag(task.category === "main" ? "Главная" : "Мелкая", task.category));
      if (task.mode === "fixed") meta.append(tag(`${TimeUtils.time(task.fixedStart)}–${TimeUtils.time(task.fixedEnd)}`, "fixed"));
      if (highest) { c.classList.add("highest"); meta.append(node("span", "priority-label", "Самый высокий приоритет")); }
      const scheduled = task.location === "day" && task.planDate === plan?.date ? plan.tasks[task.id] : null;
      if (scheduled?.unplaced) meta.append(tag(`Не помещается: ${scheduled.unplaced} мин`, "overload"));
      if (scheduled?.parts.length) {
        meta.append(tag(scheduled.parts.length > 1 ? `Частей: ${scheduled.parts.length}` : `${TimeUtils.time(scheduled.parts[0].start)}–${TimeUtils.time(scheduled.parts[0].end)}`));
      }
      if (task.location === "day" && task.planDate === plan?.date && (scheduled?.parts.length || task.mode === "fixed" && plan.summary)) c.querySelector(".task-content").append(action("В расписании", "select-task", task.id, "button-text task-schedule-link"));
      c.querySelector(".duration-pill").textContent = duration(task);
      const done = c.querySelector(".complete-button"); done.dataset.action = "complete"; done.dataset.id = task.id; done.setAttribute("aria-label", `Выполнено: ${task.title}`);
      c.querySelector(".drag-handle").setAttribute("aria-label", `Переместить: ${task.title}. Кнопки порядка находятся в меню действий.`);
      const transfer = c.querySelector(".task-transfer"); transfer.textContent = task.location === "day" ? "Не сегодня →" : "На сегодня →"; transfer.dataset.action = task.location === "day" ? "to-backlog" : "to-today"; transfer.dataset.id = task.id;
      c.querySelector("summary").setAttribute("aria-label", `Действия: ${task.title}`);
      const menu = c.querySelector(".menu-items");
      const list = TaskActions.sourceList(state, task), index = list.indexOf(task.id);
      const up = action("↑ Выше", "up", task.id, ""), down = action("↓ Ниже", "down", task.id, "");
      up.disabled = index === 0; down.disabled = index === list.length - 1;
      menu.append(action("Изменить", "edit", task.id, ""), up, down, action(task.category === "main" ? "В мелкие" : "В главные", "change-category", task.id, ""), action("Удалить", "delete", task.id, "danger"));
      if (task.progress.length) menu.prepend(action("Отменить последнюю часть", "undo-task-part", task.id, ""));
      return c;
    }
    function renderLists(state, today, plan) {
      const day = state.days[today];
      const highest = day.mainIds[0] ?? day.smallIds[0];
      const progress = TaskActions.dayProgress(state, today);
      $("today-progress-summary").textContent = progress.total ? `Выполнено ${progress.completed} из ${progress.total}` : "Задач на сегодня пока нет";
      $("today-progress-percent").textContent = `${progress.percent}%`;
      $("today-progress").value = progress.percent;
      $("today-progress").setAttribute("aria-valuetext", `${progress.percent}% — выполнено ${progress.completed} из ${progress.total}`);
      for (const location of ["day", "backlog"]) {
        const container = location === "day" ? day : state.backlog, prefix = location === "day" ? "today" : "backlog";
        for (const category of ["main", "small"]) {
          const list = $(`${prefix}-${category}-list`), ids = container[`${category}Ids`];
          list.replaceChildren(...ids.map(id => card(state.tasks[id], location === "day" && id === highest, state, plan)));
          if (!ids.length) list.append(node("p", "empty-list", location === "day" ? "Пока нет задач. Добавьте первую." : "Здесь можно оставить дела на потом."));
          $(`${prefix}-${category}-count`).textContent = ids.length;
        }
        $(`${prefix}-count`).textContent = container.mainIds.length + container.smallIds.length;
      }
    }
    function renderRoutines(day) {
      $("routine-list").replaceChildren(...day.routines.map(r => {
        const row = node("div", `routine-row${r.enabled ? "" : " inactive"}`);
        const toggle = node("input", "routine-toggle"); toggle.type = "checkbox"; toggle.checked = r.enabled; toggle.dataset.action = "toggle-routine"; toggle.dataset.id = r.id; toggle.setAttribute("aria-label", `Включить блок: ${r.title}`);
        const content = node("div", "routine-content"); content.append(node("span", "routine-name", r.title));
        const complete = r.start !== null && r.durationMinutes !== null;
        const info = `${r.kind === "rest" ? "Отдых" : "Занятое время"} · ${complete ? `${TimeUtils.time(r.start)}–${TimeUtils.time(r.start + r.durationMinutes)} · ${r.durationMinutes} мин` : r.durationMinutes !== null ? `${r.durationMinutes} мин · задайте начало` : "задайте время и длительность"}`;
        const meta = node("span", "routine-meta", r.enabled ? info : "Выключен");
        if (r.enabled && !complete) meta.classList.add("missing-time");
        content.append(meta);
        const edit = action("✎", "edit-routine", r.id, "button-icon routine-edit"); edit.setAttribute("aria-label", `Изменить блок: ${r.title}`);
        const del = action("×", "delete-routine", r.id, "button-icon routine-delete"); del.setAttribute("aria-label", `Удалить блок: ${r.title}`);
        row.append(toggle, content, edit, del); return row;
      }));
      if (!day.routines.length) $("routine-list").append(node("p", "empty-state", "Можно добавить свой блок дня."));
    }
    function renderUnfinished(state, today) {
      const dates = Object.keys(state.days).filter(d => d !== today && state.days[d].mainIds.length + state.days[d].smallIds.length > 0).sort().reverse();
      $("unfinished-count").textContent = dates.reduce((sum, d) => sum + state.days[d].mainIds.length + state.days[d].smallIds.length, 0);
      const selected = $("unfinished-date").value;
      $("unfinished-date").replaceChildren(new Option("Все даты", ""), ...dates.map(d => new Option(TimeUtils.humanDate(d), d)));
      $("unfinished-date").value = dates.includes(selected) ? selected : "";
      const dateFilter = $("unfinished-date").value, search = TimeUtils.search($("unfinished-search").value), result = [];
      for (const date of dates) {
        if (dateFilter && dateFilter !== date) continue;
        const day = state.days[date], group = node("section", "history-group"), heading = node("h3", "history-date", TimeUtils.humanDate(date)); group.append(heading);
        for (const category of ["main", "small"]) {
          const matches = day[`${category}Ids`].map(id => state.tasks[id]).filter(t => TimeUtils.search(t.title).includes(search));
          if (!matches.length) continue;
          group.append(node("p", "history-section-title", category === "main" ? "Главные" : "Мелкие"));
          for (const task of matches) {
            const row = node("article", "history-card"); row.dataset.id = task.id;
            const title = action(task.title, "view", task.id, "task-title-button");
            const meta = node("p", "history-meta", `${duration(task)}${task.mode === "fixed" ? ` · ${TimeUtils.time(task.fixedStart)}–${TimeUtils.time(task.fixedEnd)}` : ""}`);
            const buttons = node("div", "history-actions"); buttons.append(action("На сегодня", "to-today", task.id), action("Не сегодня", "to-backlog", task.id), action("Выполнено", "complete", task.id), action("Удалить", "delete", task.id, "button-text danger"));
            row.append(title, meta, buttons); group.append(row);
          }
        }
        if (group.children.length > 1) result.push(group);
      }
      $("unfinished-list").replaceChildren(...result);
      if (!result.length) $("unfinished-list").append(node("p", "empty-state", dates.length ? "Задачи не найдены" : "Нет незавершённых задач других дней."));
      $("unfinished-panel").open = state.ui.unfinishedOpen;
    }
    function renderArchive(state) {
      const all = TaskActions.archived(state); $("archive-count").textContent = all.length; $("archive-dialog-count").textContent = all.length;
      const search = TimeUtils.search($("archive-search").value), date = $("archive-date").value, todayOnly = $("archive-today").checked;
      const tasks = all.filter(t => TimeUtils.search(t.title).includes(search) && (!date || t.planDate === date) && (!todayOnly || TimeUtils.dateKey(new Date(t.archivedAt)) === TimeUtils.dateKey()));
      $("archive-list").replaceChildren(...tasks.map(t => {
        const row = node("article", "archive-card"); row.dataset.id = t.id;
        const content = node("div", "archive-content"), heading = node("h3", "archive-title", t.title);
        const source = t.planDate ? `План: ${TimeUtils.humanDate(t.planDate)}` : "Из «Не сегодня»";
        const fixed = t.mode === "fixed" ? ` · ${TimeUtils.time(t.fixedStart)}–${TimeUtils.time(t.fixedEnd)}` : "";
        content.append(heading, node("p", "history-meta", `${t.category === "main" ? "Главная" : "Мелкая"} · ${t.durationMinutes} мин${fixed}`), node("p", "history-meta", source), node("p", "archive-time", `Выполнено ${new Date(t.archivedAt).toLocaleString("ru-RU", { dateStyle: "short", timeStyle: "short" })}`));
        const buttons = node("div", "history-actions"); buttons.append(action("Отменить выполнение", "restore", t.id, "button button-light"), action("Удалить", "delete", t.id, "button-text danger"));
        row.append(node("span", "archive-check", "✓"), content, buttons); return row;
      }));
      if (!tasks.length) $("archive-list").append(node("p", "empty-state", "Задачи не найдены"));
    }
    function clock(date = new Date()) {
      $("today-date").textContent = date.toLocaleDateString("ru-RU", { weekday: "long", day: "numeric", month: "long" });
      $("current-time").textContent = date.toLocaleTimeString("ru-RU", { hour: "2-digit", minute: "2-digit" });
      $("daily-quote").textContent = TimeUtils.quote(date);
    }
    function storage() {
      const status = StateStore.status(); $("save-status").textContent = status.saved ? "Сохранено" : "Не сохранено";
      $("save-status").classList.toggle("unsaved", !status.saved);
      const warning = status.error || (status.nearLimit ? "Хранилище почти заполнено. Скачайте копию или очистите старый архив." : "");
      $("storage-alert").hidden = !warning; $("storage-alert").textContent = warning; $("storage-alert").dataset.code = status.code || (status.nearLimit ? "STORAGE_NEAR_LIMIT" : "");
      $("storage-actions").hidden = !warning || status.blocked; $("reload-storage").hidden = !status.conflict;
      $("recovery-panel").hidden = !status.blocked; document.querySelector(".workspace").hidden = status.blocked;
      $("add-task").disabled = status.blocked; $("open-archive").disabled = status.blocked; $("download-backup").disabled = status.blocked;
      $("backup-size").textContent = `Оценка состояния: ${(status.size / 1048576).toFixed(2)} MiB. Предупреждение от 3 MiB, защитный предел 4 MiB. Это оценка, а не свободное место браузера.${status.saved ? "" : " Текущие данные не сохранены в браузере."}`;
    }
    function updateNow(now, plan) {
      if (!plan?.summary) return;
      const minute = now.getHours() * 60 + now.getMinutes() + now.getSeconds() / 60;
      const line = $("timeline").querySelector(".now-line");
      if (line) { line.hidden = minute < plan.start || minute > plan.end; line.style.top = `${(minute - plan.start) * 2}px`; line.firstChild.textContent = `Сейчас ${TimeUtils.time(Math.floor(minute))}`; }
      $("timeline").querySelectorAll("[data-end]").forEach(el => el.classList.toggle("passed", Number(el.dataset.end) <= minute));
    }
    function scrollNow(plan, now = new Date()) {
      if (!plan?.summary) return;
      const minute = now.getHours() * 60 + now.getMinutes();
      const scroller = $("timeline-scroll");
      scroller.scrollTop = Math.max(0, Math.min(scroller.scrollHeight - scroller.clientHeight, (Math.min(plan.end, Math.max(plan.start, minute)) - plan.start) * 2 - scroller.clientHeight / 3));
    }
    function renderDetail(plan) {
      const detail = $("timeline-detail"), item = plan.intervals.find(i => i.id === selectedInterval);
      detail.hidden = !item;
      if (!item) { selectedInterval = null; detail.replaceChildren(); return; }
      const close = action("Закрыть", "hide-detail");
      const heading = node("div", "panel-heading"); heading.append(node("h3", "", item.title), close);
      const start = item.originalStart ?? item.start, end = item.originalEnd ?? item.end;
      const time = node("p", "", `${TimeUtils.time(start)}–${TimeUtils.time(end)} · ${end - start} мин${item.mode === "flexible" ? ` · часть ${item.partNumber}` : ""}`);
      const buttons = node("div", "detail-actions");
      if (item.type === "task") {
        if (item.mode === "flexible") buttons.append(action("Выполнить эту часть", "complete-part", item.id, "button button-primary"));
        else buttons.append(action("Выполнено", "complete", item.taskId, "button button-primary"));
        buttons.append(action("Изменить задачу", "edit", item.taskId));
      }
      if (item.type === "block") buttons.append(action("Изменить блок", "edit-routine", item.routineId));
      if (plan.breakSources[item.controlKey]) buttons.append(action(item.type === "break" ? "Изменить перерыв" : `Перерыв после: ${plan.breakSources[item.controlKey].minutes} мин`, "edit-break", item.controlKey));
      detail.replaceChildren(heading, time);
      if (item.sourceTitle) detail.append(node("p", "", `После «${item.sourceTitle}»`));
      if (item.conflict) detail.append(node("p", "field-error", "⚠ Пересекается с другим фиксированным блоком. Измените его время."));
      detail.append(buttons);
    }
    function selectInterval(plan, id) {
      selectedInterval = id; renderDetail(plan);
      const item = plan.intervals.find(i => i.id === id); if (!item) return;
      $("timeline-scroll").scrollTop = Math.max(0, (item.start - plan.start) * 2 - 50);
      $("timeline-detail").scrollIntoView({ block: "nearest" });
      $("timeline-detail").querySelector("button")?.focus({ preventScroll: true });
    }
    function hideDetail() { selectedInterval = null; $("timeline-detail").hidden = true; $("timeline-scroll").focus({ preventScroll: true }); }
    function renderSchedule(state, plan) {
      const scrollTop = $("timeline-scroll").scrollTop, first = renderedDate !== plan.date;
      $("schedule-status").textContent = plan.status;
      $("schedule-status").className = `schedule-status ${plan.warnings.length ? "warning" : plan.status === "Всё помещается" ? "good" : ""}`;
      $("schedule-summary").replaceChildren();
      const notes = [];
      if (plan.summary) {
        const labels = [["День", plan.summary.dayMinutes], ["Осталось времени", plan.summary.available], ["Работа", plan.summary.work], ["Отдых", plan.summary.rest], ["Свободно", plan.summary.free], ["Не помещается", plan.summary.unplaced]];
        for (const [label, minutes] of labels) { const box = node("div", "summary-item"); box.append(node("dt", "", label), node("dd", "", `${minutes} мин`)); $("schedule-summary").append(box); }
        if (plan.warnings.some(w => ["FIXED_OVERLAP", "OUTSIDE_DAY", "BLOCK_INCOMPLETE"].includes(w.code))) notes.push("Предварительный расчёт: исправьте предупреждения.");
        if (plan.summary.missed) notes.push(`Пропущено фиксированных задач: ${plan.summary.missed}`);
      }
      $("schedule-note").hidden = !notes.length; $("schedule-note").textContent = notes.join(" ");
      $("schedule-warnings").replaceChildren(...plan.warnings.map(w => {
        const row = node("li", "schedule-warning"); row.dataset.code = w.code; row.append(node("p", "", `${w.code === "FIXED_OVERLAP" ? "⚠ " : ""}${w.text}`));
        const buttons = node("div", "warning-actions");
        for (const ref of w.refs) {
          if (ref.type === "block") buttons.append(action(`Изменить: ${state.days[plan.date].routines.find(r => r.id === ref.id)?.title ?? "блок"}`, "edit-routine", ref.id));
          else if (state.tasks[ref.id]?.status === "active") {
            buttons.append(action(`Изменить: ${state.tasks[ref.id].title}`, "edit", ref.id));
            if (["FIXED_MISSED", "OVERLOAD", "OUTSIDE_DAY"].includes(w.code)) buttons.append(action(`Не сегодня: ${state.tasks[ref.id].title}`, "to-backlog", ref.id));
            if (w.code === "FIXED_MISSED") buttons.append(action("Выполнено", "complete", ref.id));
          }
        }
        if (w.controlKey && plan.breakSources[w.controlKey]) buttons.append(action("Изменить перерыв", "edit-break", w.controlKey));
        if (w.code === "DAY_INCOMPLETE") buttons.append(action("Задать границы дня", "day-settings"));
        if (buttons.children.length) row.append(buttons); return row;
      }));
      $("timeline-scroll").hidden = !plan.summary; $("timeline-toolbar").hidden = !plan.summary;
      $("timeline").replaceChildren();
      if (plan.summary) {
        $("timeline").style.height = `${(plan.end - plan.start) * 2}px`;
        const ticks = new Set([plan.start, plan.end]);
        for (let m = Math.ceil(plan.start / 15) * 15; m < plan.end; m += 15) ticks.add(m);
        for (const minute of [...ticks].sort((a, b) => a - b)) {
          const tick = node("div", `timeline-tick${minute % 60 === 0 ? " hour" : ""}${minute === plan.start || minute === plan.end ? " boundary" : ""}`); tick.style.top = `${(minute - plan.start) * 2}px`;
          tick.append(node("span", "timeline-label", TimeUtils.time(minute))); $("timeline").append(tick);
        }
        for (const item of plan.intervals) {
          const height = (item.end - item.start) * 2;
          if (item.type === "free") { const free = node("div", "timeline-free", height >= 44 ? item.title : ""); free.style.top = `${(item.start - plan.start) * 2}px`; free.style.height = `${height}px`; free.dataset.end = item.end; $("timeline").append(free); continue; }
          const part = action("", "select-interval", item.id, `timeline-item ${item.mode ?? ""} ${item.kind} ${item.type}${item.conflict ? " conflict" : ""}${height < 44 ? " short" : ""}`);
          part.style.top = `${(item.start - plan.start) * 2}px`; part.style.height = `${height}px`;
          const columns = item.columns ?? 1, column = item.column ?? 0;
          part.style.left = `calc(49px + (100% - 49px) * ${column / columns})`; part.style.width = `calc((100% - 49px) / ${columns} - 3px)`;
          part.dataset.end = item.end;
          part.setAttribute("aria-label", `${item.title}, ${TimeUtils.time(item.originalStart ?? item.start)}–${TimeUtils.time(item.originalEnd ?? item.end)}, ${item.end - item.start} минут${item.conflict ? ", пересечение" : ""}${item.mode === "flexible" ? `, часть ${item.partNumber}` : ""}`);
          part.title = part.getAttribute("aria-label");
          if (height >= 44) { part.append(node("span", "timeline-title", item.title), node("span", "timeline-time", `${TimeUtils.time(item.start)}–${TimeUtils.time(item.end)}${item.mode === "flexible" ? ` · часть ${item.partNumber}` : ""}`)); if (item.conflict) part.append(node("span", "timeline-conflict", "⚠ Пересечение")); }
          $("timeline").append(part);
        }
        const line = node("div", "now-line"); line.append(node("span", "now-label")); $("timeline").append(line);
        updateNow(new Date(), plan);
        if (first) scrollNow(plan); else $("timeline-scroll").scrollTop = scrollTop;
      }
      renderedDate = plan.summary ? plan.date : null; renderDetail(plan);
      const completed = TaskActions.archived(state).filter(t => TimeUtils.dateKey(new Date(t.archivedAt)) === plan.date).length;
      $("completed-today").textContent = `Выполнено сегодня: ${completed} →`;
    }
    function render(state, today, plan) {
      renderLists(state, today, plan); renderRoutines(state.days[today]); renderUnfinished(state, today); renderArchive(state); storage(); renderSchedule(state, plan);
      const last = TaskActions.lastCompletion(state); $("undo-completion").disabled = !last;
      $("undo-completion").title = last ? `Отменить: ${last.title} · ${last.minutes} мин` : "Нет выполненных задач или частей для отмены";
      $("undo-completion").setAttribute("aria-label", last ? `Отменить выполнение: ${last.title}, ${last.minutes} минут` : "Отменить выполнение — пока нечего отменять");
      const day = state.days[today];
      for (const [id, value] of [["day-start", TimeUtils.time(day.start)], ["day-end", TimeUtils.time(day.end)], ["default-break", String(day.defaultBreakMinutes)]]) if (document.activeElement !== $(id)) $(id).value = value;
    }
    return Object.freeze({ $, node, action, render, renderArchive, renderUnfinished, clock, storage, updateNow, scrollNow, selectInterval, hideDetail, selectedTask: plan => plan?.intervals.find(i => i.id === selectedInterval)?.taskId ?? null });
  })();

  // AppController: формы, диалоги, действия и Pointer Events.
  const AppController = (() => {
    const { $, node } = PlannerView;
    let today = TimeUtils.dateKey(), taskEditId = null, routineEditId = null, drag = null, toastTimer = null, toastAction = null;
    let currentPlan = null, breakEdit = null;
    let importCandidate = null, importTicket = 0, cleanupPreview = null, cleanupBaseline = null, taskDraftDate = today;
    const drafts = new Map(), openers = new Map();
    let confirmCallback = null;
    function announce(message) { $("announcer").textContent = message; }
    function recalculate(announceResult = false) {
      const now = new Date(); PlannerView.clock(now);
      currentPlan = PlannerEngine.calculate(StateStore.get(), now, today);
      PlannerView.render(StateStore.get(), today, currentPlan);
      if (announceResult) announce("Расписание пересчитано от текущего времени");
    }
    function perform(operation, message = "", recalc = true) {
      try {
        const focused = document.activeElement;
        const id = focused.dataset.id ?? focused.closest("article[data-id]")?.dataset.id;
        const result = StateStore.transact(operation);
        if (recalc) recalculate(); else PlannerView.render(StateStore.get(), today, currentPlan);
        if (!focused.isConnected) {
          const card = [...document.querySelectorAll("article[data-id]")].find(el => el.dataset.id === id);
          let replacement = [...document.querySelectorAll("button[data-action], input[data-action]")].find(b => b.dataset.id === id && b.dataset.action === focused.dataset.action);
          if (replacement?.disabled) replacement = card?.querySelector("summary");
          if (replacement?.closest(".task-menu")) replacement.closest(".task-menu").open = true;
          if (!replacement) replacement = card?.querySelector(".task-transfer") ?? card?.querySelector("button") ?? document.querySelector("dialog[open] input, dialog[open] button") ?? $("add-task");
          replacement.focus({ preventScroll: true });
        }
        if (message) announce(message);
        return { ok: true, result };
      }
      catch (e) { PlannerView.storage(); showToast(e.message); return { ok: false }; }
    }
    function showToast(message, callback = null, label = "Отменить") {
      clearTimeout(toastTimer); toastAction = callback; $("toast-message").textContent = message;
      $("toast-undo").hidden = !callback; $("toast-undo").textContent = label; $("toast").hidden = false;
      toastTimer = setTimeout(hideToast, 15000);
    }
    function hideToast() { clearTimeout(toastTimer); $("toast").hidden = true; toastAction = null; }
    function serializeForm(id) {
      return JSON.stringify([...$(id).querySelectorAll("input, select")].map(el => [el.id, el.type === "checkbox" ? el.checked : el.value]));
    }
    function openDialog(id, focusId = null) {
      openers.set(id, document.activeElement); $(id).showModal();
      if (focusId) $(focusId).focus();
    }
    function closeDialog(id) {
      $(id).close(); drafts.delete(id);
      const opener = openers.get(id); openers.delete(id);
      const replacement = opener?.dataset.id && [...document.querySelectorAll("button[data-action], input[data-action]")].find(el => el.dataset.id === opener.dataset.id && el.dataset.action === opener.dataset.action);
      if (opener?.isConnected && opener !== document.body) opener.focus();
      else if (replacement) replacement.focus();
      else if (!document.querySelector("dialog[open]")) $("add-task").focus();
    }
    function confirm(message, callback, heading = "Подтверждение", label = "Подтвердить") {
      $("confirm-heading").textContent = heading; $("confirm-message").textContent = message; $("confirm-accept").textContent = label;
      confirmCallback = callback; openDialog("confirm-dialog", "confirm-cancel");
    }
    function requestClose(id) {
      if (id === "rollover-dialog") return resolveRollover(null);
      if (id === "backup-dialog") importTicket++;
      if (id === "import-dialog") { importCandidate = null; importTicket++; }
      if (id === "confirm-dialog") { confirmCallback = null; closeDialog(id); return; }
      if (drafts.has(id) && drafts.get(id) !== serializeForm(id)) {
        confirm("Изменения ещё не сохранены. Закрыть форму и потерять черновик?", () => closeDialog(id), "Закрыть без сохранения?", "Закрыть");
      } else closeDialog(id);
    }
    function clearErrors(prefix, form) {
      $(`${prefix}-error`).textContent = ""; $(form).querySelectorAll("[aria-invalid]").forEach(el => el.removeAttribute("aria-invalid"));
    }
    function formError(prefix, message, field) {
      $(`${prefix}-error`).textContent = message;
      if (field) { $(field).setAttribute("aria-invalid", "true"); $(field).focus(); }
      return false;
    }
    function number(value, min, max) { return value.trim() !== "" && Number.isInteger(Number(value)) && Number(value) >= min && Number(value) <= max; }
    function updateTaskMode() {
      const fixed = $("task-mode").value === "fixed";
      $("fixed-fields").hidden = !fixed; $("duration-fields").hidden = fixed;
      $("task-duration").disabled = fixed; $("task-start").disabled = !fixed; $("task-end").disabled = !fixed;
    }
    function openTask(id = null, location = "day", category = "main") {
      checkDate(); taskDraftDate = today;
      taskEditId = id; const task = id ? StateStore.get().tasks[id] : null;
      if (task && (task.status !== "active" || task.location === "day" && task.planDate !== today)) return;
      $("task-form").reset(); clearErrors("task", "task-form");
      $("task-dialog-heading").textContent = task ? "Изменить задачу" : "Новая задача";
      $("save-task").textContent = task ? "Сохранить" : "Добавить задачу";
      $("task-title").value = task?.title ?? ""; $("task-category").value = task?.category ?? category; $("task-location").value = task?.location ?? location;
      $("task-mode").value = task?.mode ?? "flexible"; $("task-mode").disabled = Boolean(task && TimeUtils.completed(task));
      $("task-duration").value = task ? task.durationMinutes : ""; $("task-start").value = task ? TimeUtils.time(task.fixedStart) : ""; $("task-end").value = task ? TimeUtils.time(task.fixedEnd) : "";
      $("task-progress-note").hidden = !task || TimeUtils.completed(task) === 0;
      $("task-progress-note").textContent = task ? `Уже выполнено ${TimeUtils.completed(task)} мин. Сохраните режим времени; длительность должна быть больше выполненного.` : "";
      updateTaskMode(); openDialog("task-dialog", "task-title"); drafts.set("task-dialog", serializeForm("task-dialog"));
    }
    function submitTask(event) {
      event.preventDefault(); clearErrors("task", "task-form");
      if (TimeUtils.dateKey() !== today) { checkDate(); return; }
      if ($( "rollover-dialog").open) return;
      const title = $("task-title").value.trim(), mode = $("task-mode").value;
      if (!title || title.length > 200) return formError("task", "Введите название от 1 до 200 символов.", "task-title");
      let duration, fixedStart = null, fixedEnd = null;
      if (mode === "fixed") {
        fixedStart = TimeUtils.parseTime($("task-start").value); fixedEnd = TimeUtils.parseTime($("task-end").value);
        if (fixedStart === null) return formError("task", "Укажите время начала.", "task-start");
        if (fixedEnd === null) return formError("task", "Укажите время окончания.", "task-end");
        if (fixedEnd <= fixedStart) return formError("task", "Окончание должно быть позже начала в пределах одного дня.", "task-end");
        duration = fixedEnd - fixedStart;
      } else {
        if (!number($("task-duration").value, 1, 1440)) return formError("task", "Длительность — целое число от 1 до 1440 минут.", "task-duration");
        duration = Number($("task-duration").value);
      }
      const task = taskEditId ? StateStore.get().tasks[taskEditId] : null;
      if (task && duration <= TimeUtils.completed(task)) return formError("task", "Длительность должна быть больше уже выполненных минут.", mode === "fixed" ? "task-end" : "task-duration");
      const fields = { title, category: $("task-category").value, location: $("task-location").value, mode, durationMinutes: duration, fixedStart, fixedEnd };
      const result = perform(state => TaskActions.saveTask(state, taskEditId, fields, today), "Задача сохранена");
      if (result.ok) closeDialog("task-dialog");
    }
    function openRoutine(id = null) {
      routineEditId = id; const r = StateStore.get().days[today].routines.find(r => r.id === id);
      $("routine-form").reset(); clearErrors("routine", "routine-form");
      $("routine-dialog-heading").textContent = r ? "Изменить блок" : "Новый блок дня";
      $("routine-title").value = r?.title ?? ""; $("routine-kind").value = r?.kind ?? "rest"; $("routine-start").value = r ? TimeUtils.time(r.start) : ""; $("routine-duration").value = r?.durationMinutes ?? ""; $("routine-enabled").checked = r?.enabled ?? true;
      routineEnd(); openDialog("routine-dialog", "routine-title"); drafts.set("routine-dialog", serializeForm("routine-dialog"));
    }
    function routineEnd() {
      const start = TimeUtils.parseTime($("routine-start").value), duration = Number($("routine-duration").value);
      $("routine-end-note").textContent = start !== null && number($("routine-duration").value, 1, 1440) && start + duration <= 1439 ? `Окончание: ${TimeUtils.time(start + duration)}` : "Окончание рассчитывается по началу и длительности.";
    }
    function submitRoutine(event) {
      event.preventDefault(); clearErrors("routine", "routine-form");
      if (TimeUtils.dateKey() !== today) { checkDate(); return; }
      const title = $("routine-title").value.trim(), enabled = $("routine-enabled").checked, value = $("routine-duration").value;
      const startValue = $("routine-start").value, start = TimeUtils.parseTime(startValue);
      if (!title || title.length > 200) return formError("routine", "Введите название от 1 до 200 символов.", "routine-title");
      if ((enabled || startValue) && start === null) return formError("routine", "Укажите время начала включённого блока.", "routine-start");
      if ((enabled || value) && !number(value, 1, 1440)) return formError("routine", "Длительность — целое число от 1 до 1440 минут.", "routine-duration");
      const duration = value ? Number(value) : null;
      if (start !== null && duration !== null && start + duration > 1439) return formError("routine", "Блок должен закончиться до полуночи, не позднее 23:59.", "routine-duration");
      const result = perform(state => {
        const day = state.days[today], existing = day.routines.find(r => r.id === routineEditId);
        const fields = { title, enabled, kind: $("routine-kind").value, start, durationMinutes: duration };
        if (existing) Object.assign(existing, fields);
        else day.routines.push({ id: TaskActions.newId(state, "routine"), ...fields, breakOverride: null });
      }, "Блок дня сохранён");
      if (result.ok) closeDialog("routine-dialog");
    }
    function openBreak(key) {
      const source = currentPlan.breakSources[key]; if (!source) return;
      breakEdit = { date: today, source: clone(source) };
      clearErrors("break", "break-form"); $("break-minutes").value = source.minutes;
      $("break-source").textContent = `После «${source.title}»${source.partNumber ? ` · часть ${source.partNumber}` : ""}`;
      openDialog("break-dialog", "break-minutes"); drafts.set("break-dialog", serializeForm("break-dialog"));
    }
    function submitBreak(event) {
      event.preventDefault(); clearErrors("break", "break-form");
      if (TimeUtils.dateKey() !== today) { checkDate(); return; }
      if (!number($("break-minutes").value, 0, 180)) return formError("break", "Перерыв — целое число от 0 до 180 минут.", "break-minutes");
      if (!breakEdit || breakEdit.date !== TimeUtils.dateKey()) return formError("break", "Этот перерыв относится к прежнему дню. Закройте форму и откройте актуальный план.");
      const result = perform(state => TaskActions.setBreak(state, breakEdit.date, breakEdit.source, Number($("break-minutes").value)), "Перерыв изменён");
      if (result.ok) closeDialog("break-dialog");
    }
    function saveDay(event) {
      event.preventDefault(); clearErrors("day", "day-form");
      if (TimeUtils.dateKey() !== today) { checkDate(); return; }
      const start = TimeUtils.parseTime($("day-start").value), end = TimeUtils.parseTime($("day-end").value), rest = $("default-break").value;
      if ($( "day-start").value && start === null) return formError("day", "Укажите корректное начало дня.", "day-start");
      if ($("day-end").value && end === null) return formError("day", "Укажите корректное окончание дня.", "day-end");
      if (start !== null && end !== null && end <= start) return formError("day", "Конец дня должен быть позже начала.", "day-end");
      if (!number(rest, 0, 180)) return formError("day", "Перерыв — целое число от 0 до 180 минут.", "default-break");
      perform(state => Object.assign(state.days[today], { start, end, defaultBreakMinutes: Number(rest) }), "Настройки дня сохранены");
    }
    function restore(id) {
      const result = perform(state => TaskActions.restore(state, id), "Задача восстановлена");
      if (!result.ok) return;
      if (result.result.location === "day" && result.result.date !== today) {
        if ($("archive-dialog").open) closeDialog("archive-dialog");
        showToast(`Возвращено в незавершённые за ${TimeUtils.humanDate(result.result.date)}`, () => revealUnfinished(result.result.date, id), "Показать");
      } else showToast(result.result.location === "backlog" ? "Задача возвращена в «Не сегодня»" : "Задача возвращена на прежнее место");
    }
    function revealUnfinished(date, id) {
      if ($("archive-dialog").open) closeDialog("archive-dialog");
      $("unfinished-search").value = ""; $("unfinished-date").value = date;
      perform(state => { state.ui.unfinishedOpen = true; }, "", false);
      const target = [...$("unfinished-list").querySelectorAll(".history-card")].find(el => el.dataset.id === id);
      const focus = target?.querySelector("button") ?? $("unfinished-search"); focus.focus(); focus.scrollIntoView({ block: "center", behavior: "smooth" }); hideToast();
    }
    function viewTask(id) {
      const task = StateStore.get().tasks[id]; if (!task) return;
      $("view-heading").textContent = task.title;
      const dl = node("dl", "view-data");
      const fields = [["Дата", TimeUtils.humanDate(task.planDate)], ["Тип", task.category === "main" ? "Главная" : "Мелкая"], ["Длительность", `${task.durationMinutes} мин`], ["Осталось", `${TimeUtils.remaining(task)} мин`]];
      if (task.mode === "fixed") fields.push(["Время", `${TimeUtils.time(task.fixedStart)}–${TimeUtils.time(task.fixedEnd)}`]);
      fields.forEach(([key, value]) => dl.append(node("dt", "", key), node("dd", "", value)));
      $("view-content").replaceChildren(dl); openDialog("view-dialog");
    }

    function downloadBackup() {
      try { BackupIO.download(BackupIO.encode(StateStore.get()), BackupIO.filename()); return true; }
      catch (e) { showToast(`Копию не удалось скачать: ${e.message}`); return false; }
    }
    function openBackup(event) { event?.currentTarget?.focus(); $("backup-error").textContent = ""; $("import-file").value = ""; PlannerView.storage(); openDialog("backup-dialog", "download-backup"); }
    async function importFile(event) {
      const file = event.target.files?.[0], ticket = ++importTicket; importCandidate = null; $("backup-error").textContent = "";
      if (!file) return;
      try {
        if (file.size > 8 * 1048576) throw new Error("file.size: файл больше 8 MiB");
        const text = await file.text(); if (ticket !== importTicket) return;
        const candidate = BackupIO.parse(text, file.size), counts = BackupIO.counts(candidate);
        importCandidate = candidate; $("import-error").textContent = "";
        $("import-counts").textContent = `Активных задач других/текущей дат: ${counts.active}. Не сегодня: ${counts.backlog}. Архив: ${counts.archive}.`;
        if ($("backup-dialog").open) closeDialog("backup-dialog");
        openDialog("import-dialog", "import-replace");
      } catch (e) { if (ticket === importTicket) { $("backup-error").textContent = e.message; importCandidate = null; } }
    }
    function installState(value, message) {
      const candidate = clone(value); const date = TimeUtils.dateKey(); TaskActions.ensureDay(candidate, date);
      StateStore.replace(candidate); today = date;
      for (const dialog of [...document.querySelectorAll("dialog[open]")].reverse()) closeDialog(dialog.id);
      drafts.clear(); confirmCallback = null; importCandidate = null; cleanupPreview = null; hideToast();
      for (const id of ["archive-search","archive-date","unfinished-search"]) $(id).value = "";
      $("archive-today").checked = false; $("unfinished-date").value = "";
      PlannerView.hideDetail(); recalculate(); showToast(message);
    }
    function replaceImport() {
      if (!importCandidate) return;
      try { installState(importCandidate, "Копия восстановлена"); }
      catch (e) { $("import-error").textContent = e.message; PlannerView.storage(); }
    }
    function updateCleanup() {
      $("cleanup-error").textContent = ""; $("cleanup-confirm").checked = false; $("cleanup-confirm").disabled = true; $("cleanup-apply").disabled = true;
      cleanupPreview = null; cleanupBaseline = null;
      try {
        const cutoff = $("cleanup-before").value;
        const preview = BackupIO.cleanup(StateStore.get(), cutoff);
        cleanupPreview = preview; cleanupBaseline = JSON.stringify(StateStore.get());
        $("cleanup-summary").textContent = `Удаляется задач: ${preview.tasks}; служебных событий: ${preview.events}; пустых старых дней: ${preview.days}. Оценка освобождаемого объёма: ${(preview.freed / 1048576).toFixed(2)} MiB.`;
        $("cleanup-list").replaceChildren(...preview.titles.map(title => node("li", "", title)));
        if (!preview.titles.length) $("cleanup-list").append(node("li", "", "Старых архивных задач до этой даты нет."));
      } catch (e) { $("cleanup-summary").textContent = ""; $("cleanup-list").replaceChildren(); $("cleanup-error").textContent = e.message; }
    }
    function openCleanup() {
      const date = new Date(); date.setDate(date.getDate() - 180);
      $("cleanup-before").max = TimeUtils.dateKey(); $("cleanup-before").value = TimeUtils.dateKey(date);
      updateCleanup(); if ($("backup-dialog").open) closeDialog("backup-dialog"); openDialog("cleanup-dialog", "cleanup-before");
    }
    function applyCleanup() {
      if (!cleanupPreview || !$("cleanup-confirm").checked || $("cleanup-confirm").disabled) return;
      if (cleanupBaseline !== JSON.stringify(StateStore.get())) { updateCleanup(); $("cleanup-error").textContent = "Данные изменились. Проверьте обновлённый список и снова скачайте копию."; return; }
      try {
        StateStore.replace(cleanupPreview.candidate); closeDialog("cleanup-dialog"); cleanupPreview = null; cleanupBaseline = null;
        recalculate(); showToast("Выбранные старые записи удалены");
      } catch (e) { $("cleanup-error").textContent = e.message; PlannerView.storage(); }
    }
    function reloadStorage() {
      const apply = () => {
        for (const dialog of [...document.querySelectorAll("dialog[open]")].reverse()) closeDialog(dialog.id);
        drafts.clear(); confirmCallback = null; hideToast(); importCandidate = null; importTicket++;
        StateStore.load(); today = TimeUtils.dateKey(); StateStore.prepareDay(today); PlannerView.hideDetail(); recalculate(); showToast("Загружены актуальные данные");
      };
      if (StateStore.status().dirty || [...drafts.keys()].some(id => $(id).open) || $("import-dialog").open) confirm("В другой вкладке изменились данные. Загрузить их? Несохранённые изменения и открытый черновик этой вкладки будут потеряны; сначала можно скачать копию.", apply, "Загрузить актуальные данные?", "Загрузить");
      else apply();
    }
    function storageChanged(event) {
      if (event.key !== STORAGE_KEY || !StateStore.externalChanged()) return;
      if (StateStore.status().dirty || document.querySelector("dialog[open]")) { StateStore.noticeExternal(); PlannerView.storage(); return; }
      StateStore.load(); today = TimeUtils.dateKey(); StateStore.prepareDay(today); recalculate(); showToast("Данные обновлены из другой вкладки");
    }
    function resolveRollover(location) {
      if ($("rollover-dialog").open) closeDialog("rollover-dialog");
      if (!location) { if ($("task-dialog").open) closeDialog("task-dialog"); return; }
      $("task-location").value = location; taskDraftDate = today;
      drafts.set("task-dialog", serializeForm("task-dialog")); $("task-title").focus();
      if (taskEditId) $("task-progress-note").textContent += " После сохранения задача будет перенесена из прежнего дня в выбранный раздел.";
    }

    function dispatchAction(button) {
      if (TimeUtils.dateKey() !== today) { checkDate(); return; }
      const { action, id, location, category } = button.dataset;
      const task = id ? StateStore.get().tasks[id] : null;
      if (action === "select-interval") return PlannerView.selectInterval(currentPlan, id);
      if (action === "hide-detail") return PlannerView.hideDetail();
      if (action === "select-task") { const item = currentPlan.intervals.find(i => i.taskId === id); if (item) PlannerView.selectInterval(currentPlan, item.id); return; }
      if (action === "day-settings") { $("day-start").focus(); $("day-start").scrollIntoView({ block: "center" }); return; }
      if (action === "edit-break") return openBreak(id);
      if (action === "complete-part") {
        const part = currentPlan.intervals.find(i => i.id === id && i.type === "task" && i.mode === "flexible");
        if (!part || today !== TimeUtils.dateKey()) return showToast("Эта часть больше не относится к сегодняшнему плану. Пересчитайте расписание.");
        const result = perform(state => TaskActions.completePart(state, part.taskId, part, today), "Часть задачи выполнена");
        if (result.ok) { PlannerView.hideDetail(); showToast(result.result.archived ? "Последняя часть выполнена — задача в архиве" : `Выполнено ${part.end - part.start} мин задачи`, () => perform(state => TaskActions.undoPart(state, part.taskId, result.result.eventId), "Выполнение части отменено")); }
        return;
      }
      if (action === "add") return openTask(null, location, category);
      if (action === "edit") return openTask(id);
      if (action === "view") return viewTask(id);
      if (action === "edit-routine") return openRoutine(id);
      if (action === "delete-routine") {
        const routine = StateStore.get().days[today].routines.find(r => r.id === id);
        if (routine) confirm(`Удалить блок «${routine.title}»?`, () => perform(state => { state.days[today].routines = state.days[today].routines.filter(r => r.id !== id); }, "Блок удалён"), "Удаление блока", "Удалить");
        return;
      }
      if (action === "toggle-routine") return; // checkbox обрабатывается через change
      if (!task) return;
      if (action === "delete") return confirm(`Удалить задачу «${task.title}»?`, () => perform(state => TaskActions.deleteTask(state, id), "Задача удалена"), "Удаление задачи", "Удалить");
      if (action === "restore") return restore(id);
      if (action === "undo-task-part") {
        const event = task.progress.at(-1); if (!event) return;
        const result = perform(state => TaskActions.undoPart(state, id, event.eventId), "Выполнение части отменено");
        if (result.ok) { hideToast(); showToast("Выполнение части отменено"); } return;
      }
      if (action === "complete") {
        const parts = currentPlan.intervals.filter(i => i.type === "task" && i.taskId === id), source = parts[0];
        const options = source ? { breakMinutes: source.breakMinutes, sourceKey: source.sourceKey, plannedStart: parts.length === 1 ? source.originalStart ?? source.start : null, plannedEnd: parts.length === 1 ? source.originalEnd ?? source.end : null, plannedIntervals: parts.map(p => ({ start: p.originalStart ?? p.start, end: p.originalEnd ?? p.end })) } : {};
        const result = perform(state => TaskActions.complete(state, id, today, new Date(), options), "Задача в архиве");
        if (result.ok) showToast("Задача в архиве", () => restore(id)); return;
      }
      if (["to-today", "to-backlog", "change-category", "up", "down"].includes(action)) {
        const destination = action === "to-today" ? "day" : action === "to-backlog" ? "backlog" : task.location;
        const type = action === "change-category" ? task.category === "main" ? "small" : "main" : task.category;
        const index = ["up", "down"].includes(action) ? TaskActions.sourceList(StateStore.get(), task).indexOf(id) + (action === "up" ? -1 : 1) : null;
        perform(state => TaskActions.move(state, id, destination, type, today, index), "Порядок задач обновлён");
      }
    }

    // Перенос начинается только с ручки, не мешает прокрутке других частей карточки.
    function startPointer(event) {
      const handle = event.target.closest(".drag-handle");
      if (!handle || event.button !== 0 || !event.isPrimary || document.querySelector("dialog[open]")) return;
      const card = handle.closest(".task-card");
      drag = { pointerId: event.pointerId, handle, card, id: card.dataset.id, x: event.clientX, y: event.clientY, lastX: event.clientX, lastY: event.clientY, started: false, zone: null, index: null, frame: null };
      try { handle.setPointerCapture(event.pointerId); } catch { /* Синтетический указатель может не иметь активного захвата. */ }
    }
    function targetPointer(x, y) {
      const zone = document.elementFromPoint(x, y)?.closest(".drop-zone");
      document.querySelectorAll(".drop-zone.drag-over").forEach(el => el.classList.remove("drag-over"));
      drag.zone = zone ?? null;
      if (!zone) { drag.marker.remove(); return; }
      zone.classList.add("drag-over");
      const cards = [...zone.querySelectorAll(".task-card")].filter(c => c !== drag.card);
      const index = cards.findIndex(c => y < c.getBoundingClientRect().top + c.getBoundingClientRect().height / 2);
      drag.index = index === -1 ? cards.length : index;
      zone.insertBefore(drag.marker, cards[drag.index] ?? null);
    }
    function scrollPointer() {
      if (!drag?.started) return;
      const edge = 64, y = drag.lastY, old = window.scrollY;
      if (y < edge) window.scrollBy(0, -Math.ceil((edge - y) / 5));
      else if (y > window.innerHeight - edge) window.scrollBy(0, Math.ceil((y - window.innerHeight + edge) / 5));
      if (old !== window.scrollY) targetPointer(drag.lastX, drag.lastY);
      drag.frame = requestAnimationFrame(scrollPointer);
    }
    function movePointer(event) {
      if (!drag || drag.pointerId !== event.pointerId) return;
      drag.lastX = event.clientX; drag.lastY = event.clientY;
      if (!drag.started && Math.hypot(event.clientX - drag.x, event.clientY - drag.y) < 6) return;
      event.preventDefault();
      if (!drag.started) {
        drag.started = true; document.querySelectorAll(".task-menu[open]").forEach(el => { el.open = false; });
        drag.ghost = drag.card.cloneNode(true); drag.ghost.classList.add("drag-ghost"); drag.ghost.setAttribute("aria-hidden", "true"); drag.ghost.inert = true;
        drag.ghost.style.width = `${drag.card.getBoundingClientRect().width}px`;
        drag.card.classList.add("drag-origin"); document.body.append(drag.ghost); document.body.classList.add("dragging");
        drag.marker = node("div", "drop-marker"); scrollPointer();
      }
      drag.ghost.style.left = `${event.clientX + 14}px`; drag.ghost.style.top = `${event.clientY + 12}px`;
      targetPointer(event.clientX, event.clientY);
    }
    function endPointer(event, cancelled = false) {
      if (!drag || event && event.pointerId !== drag.pointerId) return;
      const changedDate = TimeUtils.dateKey() !== today, notifyDate = changedDate && !cancelled; if (changedDate) cancelled = true;
      const current = drag; drag = null;
      cancelAnimationFrame(current.frame); current.ghost?.remove(); current.marker?.remove(); current.card.classList.remove("drag-origin");
      document.body.classList.remove("dragging"); document.querySelectorAll(".drag-over").forEach(el => el.classList.remove("drag-over"));
      try { current.handle.releasePointerCapture(current.pointerId); } catch { /* Захват мог завершиться самостоятельно. */ }
      if (!cancelled && current.started && current.zone) {
        perform(state => TaskActions.move(state, current.id, current.zone.dataset.location, current.zone.dataset.category, today, current.index), "Задача перемещена");
      }
      if (notifyDate) checkDate();
    }
    function checkDate() {
      const now = new Date(); PlannerView.clock(now);
      PlannerView.updateNow(now, currentPlan);
      const date = TimeUtils.dateKey(now);
      if (date !== today) {
        const previous = today, day = StateStore.get().days[previous], selected = PlannerView.selectedTask(currentPlan);
        const oldIds = [...day.mainIds, ...day.smallIds], revealId = selected ?? (taskEditId && oldIds.includes(taskEditId) ? taskEditId : oldIds[0]);
        const pendingTask = $("task-dialog").open && $("task-location").value === "day" && taskDraftDate !== date;
        // Сначала отделяем перенос от старой даты, затем меняем сегодняшнюю дату.
        if (drag) { const handle = drag.handle; try { handle.releasePointerCapture(drag.pointerId); } catch {} endPointer(null, true); }
        StateStore.prepareDay(date); today = date;
        PlannerView.hideDetail();
        if ($("confirm-dialog").open) { confirmCallback = null; closeDialog("confirm-dialog"); }
        for (const id of ["routine-dialog", "break-dialog"]) if ($(id).open) closeDialog(id);
        recalculate();
        if (pendingTask && !$("rollover-dialog").open) openDialog("rollover-dialog", "rollover-today");
        if (oldIds.length) showToast(`Начался новый день. Незавершённая задача осталась за ${TimeUtils.humanDate(previous)}${selected ? ". Подтвердите выполнение прежней части через «Незавершённые»." : ` · задач: ${oldIds.length}`}`, () => revealUnfinished(previous, revealId), "Показать");
        else showToast("Начался новый день. Открыт новый пустой план.");
      }
    }
    function init() {
      StateStore.load();
      StateStore.prepareDay(today);
      PlannerView.clock(); recalculate();
      document.addEventListener("click", event => {
        document.querySelectorAll(".task-menu[open]").forEach(menu => { if (!menu.contains(event.target)) menu.open = false; });
        const close = event.target.closest("[data-close]"); if (close) return requestClose(close.dataset.close);
        const button = event.target.closest("[data-action]"); if (button && !button.disabled) { button.focus({ preventScroll: true }); dispatchAction(button); }
      });
      document.querySelectorAll("dialog").forEach(dialog => dialog.addEventListener("cancel", event => { event.preventDefault(); requestClose(dialog.id); }));
      $("add-task").addEventListener("click", () => { $("add-task").focus(); openTask(); });
      $("add-routine").addEventListener("click", () => { $("add-routine").focus(); openRoutine(); });
      $("open-archive").addEventListener("click", () => { $("open-archive").focus(); $("archive-search").value = ""; $("archive-date").value = ""; $("archive-today").checked = false; PlannerView.renderArchive(StateStore.get()); openDialog("archive-dialog", "archive-search"); });
      $("open-backup").addEventListener("click", openBackup);
      $("download-backup").addEventListener("click", downloadBackup); $("storage-download").addEventListener("click", downloadBackup); $("import-download").addEventListener("click", downloadBackup);
      $("import-file").addEventListener("change", importFile); $("import-replace").addEventListener("click", replaceImport);
      $("open-cleanup").addEventListener("click", openCleanup); $("storage-cleanup").addEventListener("click", openCleanup);
      $("cleanup-before").addEventListener("change", updateCleanup);
      $("cleanup-download").addEventListener("click", () => { if (cleanupPreview && downloadBackup()) { $("cleanup-confirm").disabled = false; } });
      $("cleanup-confirm").addEventListener("change", () => { $("cleanup-apply").disabled = !$("cleanup-confirm").checked || !cleanupPreview || !(cleanupPreview.tasks + cleanupPreview.events + cleanupPreview.days); });
      $("cleanup-apply").addEventListener("click", applyCleanup);
      $("reload-storage").addEventListener("click", reloadStorage);
      $("recovery-import").addEventListener("click", openBackup);
      $("download-raw").addEventListener("click", () => BackupIO.download(StateStore.raw() ?? "", BackupIO.filename(new Date(), "txt"), "text/plain;charset=utf-8"));
      $("reset-state").addEventListener("click", () => confirm("Создать пустой план вместо повреждённой записи? Сначала можно скачать исходную строку. Сохранённая запись будет заменена только после успешной записи нового плана.", () => { try { installState(TaskActions.emptyState(), "Создан пустой план"); } catch (e) { PlannerView.storage(); showToast(e.message); } }, "Создать пустой план?", "Создать"));
      $("rollover-today").addEventListener("click", () => resolveRollover("day")); $("rollover-backlog").addEventListener("click", () => resolveRollover("backlog")); $("rollover-cancel").addEventListener("click", () => resolveRollover(null));
      window.addEventListener("storage", storageChanged);
      $("undo-completion").addEventListener("click", () => {
        if (TimeUtils.dateKey() !== today) { checkDate(); return; }
        const last = TaskActions.lastCompletion(StateStore.get()); if (!last) return;
        hideToast();
        if (StateStore.get().tasks[last.taskId].status === "archived") restore(last.taskId);
        else { const result = perform(state => TaskActions.undoPart(state, last.taskId, last.eventId), "Выполнение части отменено"); if (result.ok) showToast(`Выполнение части «${last.title}» отменено`); }
      });
      $("task-mode").addEventListener("change", updateTaskMode);
      $("task-form").addEventListener("submit", submitTask); $("routine-form").addEventListener("submit", submitRoutine);
      $("break-form").addEventListener("submit", submitBreak);
      $("recalculate").addEventListener("click", () => { checkDate(); recalculate(true); });
      $("timeline-now").addEventListener("click", () => PlannerView.scrollNow(currentPlan));
      $("completed-today").addEventListener("click", () => { $("archive-search").value = ""; $("archive-date").value = ""; $("archive-today").checked = true; PlannerView.renderArchive(StateStore.get()); openDialog("archive-dialog", "archive-search"); });
      $("routine-form").addEventListener("input", routineEnd); $("day-form").addEventListener("change", saveDay); $("day-form").addEventListener("submit", saveDay);
      $("confirm-form").addEventListener("submit", event => { event.preventDefault(); if (TimeUtils.dateKey() !== today) { checkDate(); return; } const callback = confirmCallback; confirmCallback = null; closeDialog("confirm-dialog"); callback?.(); });
      document.addEventListener("change", event => {
        if (event.target.dataset.action === "toggle-routine") { if (TimeUtils.dateKey() !== today) { checkDate(); return; } perform(state => { const r = state.days[today].routines.find(r => r.id === event.target.dataset.id); if (r) r.enabled = event.target.checked; }); }
      });
      for (const id of ["archive-search", "archive-date", "archive-today"]) $(id).addEventListener("input", () => PlannerView.renderArchive(StateStore.get()));
      $("archive-reset").addEventListener("click", () => { $("archive-search").value = ""; $("archive-date").value = ""; $("archive-today").checked = false; PlannerView.renderArchive(StateStore.get()); $("archive-search").focus(); });
      for (const id of ["unfinished-search", "unfinished-date"]) $(id).addEventListener("input", () => PlannerView.renderUnfinished(StateStore.get(), today));
      $("unfinished-panel").addEventListener("toggle", () => { if ($("unfinished-panel").open !== StateStore.get().ui.unfinishedOpen) perform(state => { state.ui.unfinishedOpen = $("unfinished-panel").open; }, "", false); });
      $("toast-undo").addEventListener("click", () => { const callback = toastAction; hideToast(); callback?.(); }); $("toast-dismiss").addEventListener("click", hideToast);
      document.addEventListener("pointerdown", startPointer); document.addEventListener("pointermove", movePointer, { passive: false });
      document.addEventListener("pointerup", event => endPointer(event)); document.addEventListener("pointercancel", event => endPointer(event, true));
      document.addEventListener("lostpointercapture", event => endPointer(event, true));
      document.addEventListener("keydown", event => {
        if (event.key === "Escape" && drag) { event.preventDefault(); endPointer(null, true); }
        if (event.key !== "Tab") return;
        const dialog = [...document.querySelectorAll("dialog[open]")].at(-1);
        if (!dialog) return;
        const controls = [...dialog.querySelectorAll("button,input,select,textarea,summary,a[href],[tabindex]")].filter(el => !el.disabled && el.tabIndex >= 0 && el.getClientRects().length > 0);
        const first = controls[0], last = controls.at(-1);
        if (!first) return;
        if (event.shiftKey && (document.activeElement === first || !dialog.contains(document.activeElement))) { event.preventDefault(); last.focus(); }
        else if (!event.shiftKey && (document.activeElement === last || !dialog.contains(document.activeElement))) { event.preventDefault(); first.focus(); }
      });
      window.addEventListener("blur", () => endPointer(null, true));
      document.addEventListener("visibilitychange", () => { if (!document.hidden) { checkDate(); recalculate(); } else endPointer(null, true); });
      setInterval(checkDate, 30000);
      window.addEventListener("beforeunload", event => { if (!StateStore.status().saved || [...drafts].some(([id, baseline]) => $(id).open && baseline !== serializeForm(id))) { event.preventDefault(); event.returnValue = ""; } });
    }
    return Object.freeze({ init, getPlan: () => clone(currentPlan) });
  })();

  // Отдельные интерфейсы для проверки инвариантов; состояние выдаётся только копией.
  window.MoyDen = Object.freeze({ TimeUtils, StateValidator, TaskActions, PlannerEngine, BackupIO, getState: () => clone(StateStore.get()), getPlan: AppController.getPlan, quotes: QUOTES });
  AppController.init();
})();

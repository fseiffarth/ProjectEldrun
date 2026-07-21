import { useMemo } from "react";
import { create } from "zustand";

/**
 * Eldrun's in-house internationalization (i18n) — the ONE place every language
 * lives, so adding a string or a whole language is a single edit here and never
 * a hunt through the component tree.
 *
 * Design (kept deliberately dependency-free — no i18next, no network):
 *  - `TRANSLATIONS` is a flat `lang → (key → text)` map. English (`en`) is the
 *    source of truth and holds *every* key; the other languages provide what
 *    they translate and fall back to English (then to the raw key) for anything
 *    missing, so a half-translated language degrades gracefully instead of
 *    rendering blanks.
 *  - The current language is a tiny zustand store (`useI18nStore`). Switching is
 *    **instant**: `setLangLocal` flips one field and every component reading
 *    `useT()` re-renders in place — no reload, no restart. Persistence rides the
 *    ordinary settings file (`Settings.language`); this store is only the live,
 *    reactive mirror, seeded from a localStorage cache so the first paint after
 *    launch already shows the chosen language before settings finish loading.
 *
 * To add a language: add its code to `Language`, a `{ value, label }` row to
 * `LANGUAGES`, and a block to `TRANSLATIONS`. To add a string: add the key to
 * the `en` block (and, ideally, the others) and call `t("your.key")`.
 */
export type Language = "en" | "de" | "es" | "fr" | "it";

/** The languages offered in the switcher, labelled in their own tongue. */
export const LANGUAGES: { value: Language; label: string }[] = [
  { value: "en", label: "English" },
  { value: "de", label: "Deutsch" },
  { value: "es", label: "Español" },
  { value: "fr", label: "Français" },
  { value: "it", label: "Italiano" },
];

const LANG_CODES = new Set<string>(LANGUAGES.map((l) => l.value));

/** Coerce an arbitrary string (settings value, cache) to a supported language. */
export function normalizeLang(value: string | null | undefined): Language {
  return value && LANG_CODES.has(value) ? (value as Language) : "en";
}

// English is the base: it defines the full key set. Other languages need only
// override; anything absent falls through to English via `translate`.
const en = {
  // Common action words, shared across surfaces.
  "common.back": "Back",
  "common.cancel": "Cancel",
  "common.remove": "Remove",
  "common.loading": "Loading…",
  "common.default": "default",

  // Settings — main panel.
  "settings.title": "Settings",
  "settings.theme": "Theme",
  "settings.language": "Language",
  "settings.language.help":
    "Sets the language of Eldrun's interface. Takes effect immediately — no restart needed.",
  "settings.runScriptsBg": "Run scripts in background",
  "settings.claudeRemote": "Claude remote control",
  "settings.headlessRemote": "Headless remote connections",
  "settings.persistLocal": "Persistent local sessions (tmux)",
  "settings.energySaver": "Energy saver",
  "energy.off": "Off",
  "energy.battery": "On battery",
  "energy.always": "Always",
  "settings.debug": "Debug mode",
  "settings.experimental": "Experimental",
  "settings.agentModeToggle": "Plan/Auto toggle on agent tabs",
  "settings.pythonRunDebug": "Python Run/Debug in the code viewer",
  "settings.resourceMonitor": "Resource monitor",
  "settings.showCpu": "Show CPU usage",
  "settings.showRam": "Show RAM usage",
  "settings.showGpu": "Show GPU usage",

  // Settings — calendar.
  "settings.calendar": "Calendar",
  "settings.weekStartsOn": "Week starts on",
  "day.sunday": "Sunday",
  "day.monday": "Monday",
  "settings.defaultView": "Default view",
  "view.day": "Day",
  "view.week": "Week",
  "view.multiweek": "Multiweek",
  "view.month": "Month",
  "view.agenda": "Agenda",
  "view.tasks": "Tasks",
  "settings.clock24": "24-hour clock",
  "settings.dayGridStart": "Day grid starts at",
  "settings.defaultReminder": "Default reminder",
  "reminder.none": "None",
  "reminder.5": "5 minutes before",
  "reminder.15": "15 minutes before",
  "reminder.30": "30 minutes before",
  "reminder.60": "1 hour before",
  "reminder.1440": "1 day before",

  // Settings — hints & onboarding.
  "settings.hintsOnboarding": "Hints & onboarding",
  "settings.showHints": "Show contextual hints",
  "settings.howToStart": "How to start...",
  "settings.takeTour": "Take a tour",
  "settings.lessons": "Lessons",
  "settings.resetHints": "Reset hints",

  // Settings — layout.
  "settings.layout": "Layout",
  "settings.windowZoom": "Window zoom",
  "settings.minSubWidth": "Min subwindow width (px)",
  "settings.minSubHeight": "Min subwindow height (px)",

  // Settings — downloads.
  "settings.downloads": "Downloads",
  "settings.noDownloadFolders": "No folders added — the system Downloads folder is used.",
  "settings.addDownloadFolder": "Add download folder...",

  // Settings — usage stats.
  "settings.usageStats": "Usage stats",
  "settings.dailyRecap": "Show the recap at the start of each day",
  "settings.openUsageStats": "Open usage stats",

  // Settings — sub-panel navigation ("More settings").
  "settings.moreSettings": "More settings",
  "nav.git.title": "Git Hosting",
  "nav.git.blurb": "Hosting profile, access token, and publishing.",
  "nav.vpn.title": "VPN Auto-Connect",
  "nav.vpn.blurb": "Arm a stored tunnel to connect on launch.",
  "nav.remoteHosts.title": "Remote Connections",
  "nav.remoteHosts.blurb": "Set a standard path per SSH host.",
  "nav.global.title": "Global Apps",
  "nav.global.blurb": "Toolbar launchers shown across every project.",
  "nav.filetypes.title": "File Type Apps",
  "nav.filetypes.blurb": "Choose which app opens each file type.",
  "nav.agents.title": "Manage Agents",
  "nav.agents.blurb": "Install or update the agent CLIs.",
  "nav.shortcuts.title": "Keyboard Shortcuts",
  "nav.shortcuts.blurb": "Rebind the navigation chords.",
  "nav.archive.title": "Archived Projects",
  "nav.archive.blurb": "Restore or permanently delete archived projects.",
  "nav.scaffoldRepair.title": "Repair Project Scaffold",
  "nav.scaffoldRepair.blurb": "Regenerate missing scaffold files.",
  "nav.help.title": "Feature Guide",
  "nav.help.blurb": "Full glossary of Eldrun's features.",
} as const;

/** The key set every component is allowed to translate. */
export type TranslationKey = keyof typeof en;

type Dict = Partial<Record<TranslationKey, string>>;

const de: Dict = {
  "common.back": "Zurück",
  "common.cancel": "Abbrechen",
  "common.remove": "Entfernen",
  "common.loading": "Wird geladen…",
  "common.default": "Standard",

  "settings.title": "Einstellungen",
  "settings.theme": "Design",
  "settings.language": "Sprache",
  "settings.language.help":
    "Legt die Sprache der Eldrun-Oberfläche fest. Wirkt sofort — kein Neustart nötig.",
  "settings.runScriptsBg": "Skripte im Hintergrund ausführen",
  "settings.claudeRemote": "Claude-Fernsteuerung",
  "settings.headlessRemote": "Verbindungen im Hintergrund",
  "settings.persistLocal": "Persistente lokale Sitzungen (tmux)",
  "settings.energySaver": "Energiesparen",
  "energy.off": "Aus",
  "energy.battery": "Im Akkubetrieb",
  "energy.always": "Immer",
  "settings.debug": "Debug-Modus",
  "settings.experimental": "Experimentell",
  "settings.agentModeToggle": "Plan/Auto-Umschalter für Agenten-Tabs",
  "settings.pythonRunDebug": "Python Ausführen/Debuggen im Code-Viewer",
  "settings.resourceMonitor": "Ressourcenmonitor",
  "settings.showCpu": "CPU-Auslastung anzeigen",
  "settings.showRam": "RAM-Auslastung anzeigen",
  "settings.showGpu": "GPU-Auslastung anzeigen",

  "settings.calendar": "Kalender",
  "settings.weekStartsOn": "Woche beginnt am",
  "day.sunday": "Sonntag",
  "day.monday": "Montag",
  "settings.defaultView": "Standardansicht",
  "view.day": "Tag",
  "view.week": "Woche",
  "view.multiweek": "Mehrere Wochen",
  "view.month": "Monat",
  "view.agenda": "Agenda",
  "view.tasks": "Aufgaben",
  "settings.clock24": "24-Stunden-Format",
  "settings.dayGridStart": "Tagesraster beginnt um",
  "settings.defaultReminder": "Standarderinnerung",
  "reminder.none": "Keine",
  "reminder.5": "5 Minuten vorher",
  "reminder.15": "15 Minuten vorher",
  "reminder.30": "30 Minuten vorher",
  "reminder.60": "1 Stunde vorher",
  "reminder.1440": "1 Tag vorher",

  "settings.hintsOnboarding": "Hinweise & Einführung",
  "settings.showHints": "Kontextbezogene Hinweise anzeigen",
  "settings.howToStart": "Erste Schritte...",
  "settings.takeTour": "Tour starten",
  "settings.lessons": "Lektionen",
  "settings.resetHints": "Hinweise zurücksetzen",

  "settings.layout": "Layout",
  "settings.windowZoom": "Fenster-Zoom",
  "settings.minSubWidth": "Min. Breite des Unterfensters (px)",
  "settings.minSubHeight": "Min. Höhe des Unterfensters (px)",

  "settings.downloads": "Downloads",
  "settings.noDownloadFolders":
    "Keine Ordner hinzugefügt — der System-Download-Ordner wird verwendet.",
  "settings.addDownloadFolder": "Download-Ordner hinzufügen...",

  "settings.usageStats": "Nutzungsstatistik",
  "settings.dailyRecap": "Zusammenfassung zu Beginn jedes Tages anzeigen",
  "settings.openUsageStats": "Nutzungsstatistik öffnen",

  "settings.moreSettings": "Weitere Einstellungen",
  "nav.git.title": "Git-Hosting",
  "nav.git.blurb": "Hosting-Profil, Zugriffstoken und Veröffentlichung.",
  "nav.vpn.title": "VPN automatisch verbinden",
  "nav.vpn.blurb": "Einen gespeicherten Tunnel beim Start verbinden.",
  "nav.remoteHosts.title": "Remote-Verbindungen",
  "nav.remoteHosts.blurb": "Einen Standardpfad je SSH-Host festlegen.",
  "nav.global.title": "Globale Apps",
  "nav.global.blurb": "Toolbar-Starter, die in jedem Projekt angezeigt werden.",
  "nav.filetypes.title": "Apps nach Dateityp",
  "nav.filetypes.blurb": "Wählen, welche App jeden Dateityp öffnet.",
  "nav.agents.title": "Agenten verwalten",
  "nav.agents.blurb": "Die Agenten-CLIs installieren oder aktualisieren.",
  "nav.shortcuts.title": "Tastenkürzel",
  "nav.shortcuts.blurb": "Die Navigationskürzel neu belegen.",
  "nav.archive.title": "Archivierte Projekte",
  "nav.archive.blurb": "Archivierte Projekte wiederherstellen oder endgültig löschen.",
  "nav.scaffoldRepair.title": "Projektgerüst reparieren",
  "nav.scaffoldRepair.blurb": "Fehlende Gerüstdateien neu erzeugen.",
  "nav.help.title": "Funktionsübersicht",
  "nav.help.blurb": "Vollständiges Glossar der Eldrun-Funktionen.",
};

const es: Dict = {
  "common.back": "Atrás",
  "common.cancel": "Cancelar",
  "common.remove": "Quitar",
  "common.loading": "Cargando…",
  "common.default": "predeterminado",

  "settings.title": "Configuración",
  "settings.theme": "Tema",
  "settings.language": "Idioma",
  "settings.language.help":
    "Establece el idioma de la interfaz de Eldrun. Se aplica al instante — sin reiniciar.",
  "settings.runScriptsBg": "Ejecutar scripts en segundo plano",
  "settings.claudeRemote": "Control remoto de Claude",
  "settings.headlessRemote": "Conexiones remotas en segundo plano",
  "settings.persistLocal": "Sesiones locales persistentes (tmux)",
  "settings.energySaver": "Ahorro de energía",
  "energy.off": "Desactivado",
  "energy.battery": "Con batería",
  "energy.always": "Siempre",
  "settings.debug": "Modo de depuración",
  "settings.experimental": "Experimental",
  "settings.agentModeToggle": "Alternar Plan/Auto en pestañas de agente",
  "settings.pythonRunDebug": "Ejecutar/Depurar Python en el visor de código",
  "settings.resourceMonitor": "Monitor de recursos",
  "settings.showCpu": "Mostrar uso de CPU",
  "settings.showRam": "Mostrar uso de RAM",
  "settings.showGpu": "Mostrar uso de GPU",

  "settings.calendar": "Calendario",
  "settings.weekStartsOn": "La semana empieza el",
  "day.sunday": "Domingo",
  "day.monday": "Lunes",
  "settings.defaultView": "Vista predeterminada",
  "view.day": "Día",
  "view.week": "Semana",
  "view.multiweek": "Varias semanas",
  "view.month": "Mes",
  "view.agenda": "Agenda",
  "view.tasks": "Tareas",
  "settings.clock24": "Reloj de 24 horas",
  "settings.dayGridStart": "La cuadrícula del día empieza a las",
  "settings.defaultReminder": "Recordatorio predeterminado",
  "reminder.none": "Ninguno",
  "reminder.5": "5 minutos antes",
  "reminder.15": "15 minutos antes",
  "reminder.30": "30 minutos antes",
  "reminder.60": "1 hora antes",
  "reminder.1440": "1 día antes",

  "settings.hintsOnboarding": "Sugerencias e introducción",
  "settings.showHints": "Mostrar sugerencias contextuales",
  "settings.howToStart": "Cómo empezar...",
  "settings.takeTour": "Hacer un recorrido",
  "settings.lessons": "Lecciones",
  "settings.resetHints": "Restablecer sugerencias",

  "settings.layout": "Diseño",
  "settings.windowZoom": "Zoom de ventana",
  "settings.minSubWidth": "Ancho mín. de subventana (px)",
  "settings.minSubHeight": "Alto mín. de subventana (px)",

  "settings.downloads": "Descargas",
  "settings.noDownloadFolders":
    "No se han añadido carpetas — se usa la carpeta de Descargas del sistema.",
  "settings.addDownloadFolder": "Añadir carpeta de descargas...",

  "settings.usageStats": "Estadísticas de uso",
  "settings.dailyRecap": "Mostrar el resumen al inicio de cada día",
  "settings.openUsageStats": "Abrir estadísticas de uso",

  "settings.moreSettings": "Más ajustes",
  "nav.git.title": "Alojamiento Git",
  "nav.git.blurb": "Perfil de alojamiento, token de acceso y publicación.",
  "nav.vpn.title": "Conexión automática VPN",
  "nav.vpn.blurb": "Activar un túnel guardado para conectar al arrancar.",
  "nav.remoteHosts.title": "Conexiones remotas",
  "nav.remoteHosts.blurb": "Definir una ruta estándar por host SSH.",
  "nav.global.title": "Apps globales",
  "nav.global.blurb": "Lanzadores de la barra mostrados en todos los proyectos.",
  "nav.filetypes.title": "Apps por tipo de archivo",
  "nav.filetypes.blurb": "Elegir qué app abre cada tipo de archivo.",
  "nav.agents.title": "Gestionar agentes",
  "nav.agents.blurb": "Instalar o actualizar las CLI de los agentes.",
  "nav.shortcuts.title": "Atajos de teclado",
  "nav.shortcuts.blurb": "Reasignar los atajos de navegación.",
  "nav.archive.title": "Proyectos archivados",
  "nav.archive.blurb": "Restaurar o eliminar permanentemente proyectos archivados.",
  "nav.scaffoldRepair.title": "Reparar estructura del proyecto",
  "nav.scaffoldRepair.blurb": "Regenerar archivos de estructura que falten.",
  "nav.help.title": "Guía de funciones",
  "nav.help.blurb": "Glosario completo de las funciones de Eldrun.",
};

const fr: Dict = {
  "common.back": "Retour",
  "common.cancel": "Annuler",
  "common.remove": "Supprimer",
  "common.loading": "Chargement…",
  "common.default": "par défaut",

  "settings.title": "Paramètres",
  "settings.theme": "Thème",
  "settings.language": "Langue",
  "settings.language.help":
    "Définit la langue de l'interface d'Eldrun. Effet immédiat — aucun redémarrage.",
  "settings.runScriptsBg": "Exécuter les scripts en arrière-plan",
  "settings.claudeRemote": "Contrôle à distance de Claude",
  "settings.headlessRemote": "Connexions distantes sans interface",
  "settings.persistLocal": "Sessions locales persistantes (tmux)",
  "settings.energySaver": "Économiseur d'énergie",
  "energy.off": "Désactivé",
  "energy.battery": "Sur batterie",
  "energy.always": "Toujours",
  "settings.debug": "Mode débogage",
  "settings.experimental": "Expérimental",
  "settings.agentModeToggle": "Bascule Plan/Auto sur les onglets d'agent",
  "settings.pythonRunDebug": "Exécuter/Déboguer Python dans la visionneuse de code",
  "settings.resourceMonitor": "Moniteur de ressources",
  "settings.showCpu": "Afficher l'utilisation du CPU",
  "settings.showRam": "Afficher l'utilisation de la RAM",
  "settings.showGpu": "Afficher l'utilisation du GPU",

  "settings.calendar": "Calendrier",
  "settings.weekStartsOn": "La semaine commence le",
  "day.sunday": "Dimanche",
  "day.monday": "Lundi",
  "settings.defaultView": "Vue par défaut",
  "view.day": "Jour",
  "view.week": "Semaine",
  "view.multiweek": "Multi-semaine",
  "view.month": "Mois",
  "view.agenda": "Agenda",
  "view.tasks": "Tâches",
  "settings.clock24": "Format 24 heures",
  "settings.dayGridStart": "La grille du jour commence à",
  "settings.defaultReminder": "Rappel par défaut",
  "reminder.none": "Aucun",
  "reminder.5": "5 minutes avant",
  "reminder.15": "15 minutes avant",
  "reminder.30": "30 minutes avant",
  "reminder.60": "1 heure avant",
  "reminder.1440": "1 jour avant",

  "settings.hintsOnboarding": "Astuces et prise en main",
  "settings.showHints": "Afficher les astuces contextuelles",
  "settings.howToStart": "Comment démarrer...",
  "settings.takeTour": "Faire une visite",
  "settings.lessons": "Leçons",
  "settings.resetHints": "Réinitialiser les astuces",

  "settings.layout": "Disposition",
  "settings.windowZoom": "Zoom de la fenêtre",
  "settings.minSubWidth": "Largeur min. de la sous-fenêtre (px)",
  "settings.minSubHeight": "Hauteur min. de la sous-fenêtre (px)",

  "settings.downloads": "Téléchargements",
  "settings.noDownloadFolders":
    "Aucun dossier ajouté — le dossier Téléchargements du système est utilisé.",
  "settings.addDownloadFolder": "Ajouter un dossier de téléchargement...",

  "settings.usageStats": "Statistiques d'utilisation",
  "settings.dailyRecap": "Afficher le récapitulatif au début de chaque journée",
  "settings.openUsageStats": "Ouvrir les statistiques d'utilisation",

  "settings.moreSettings": "Plus de paramètres",
  "nav.git.title": "Hébergement Git",
  "nav.git.blurb": "Profil d'hébergement, jeton d'accès et publication.",
  "nav.vpn.title": "Connexion VPN automatique",
  "nav.vpn.blurb": "Armer un tunnel enregistré pour se connecter au lancement.",
  "nav.remoteHosts.title": "Connexions distantes",
  "nav.remoteHosts.blurb": "Définir un chemin standard par hôte SSH.",
  "nav.global.title": "Applications globales",
  "nav.global.blurb": "Lanceurs de barre d'outils affichés dans tous les projets.",
  "nav.filetypes.title": "Applications par type de fichier",
  "nav.filetypes.blurb": "Choisir quelle application ouvre chaque type de fichier.",
  "nav.agents.title": "Gérer les agents",
  "nav.agents.blurb": "Installer ou mettre à jour les CLI des agents.",
  "nav.shortcuts.title": "Raccourcis clavier",
  "nav.shortcuts.blurb": "Réattribuer les raccourcis de navigation.",
  "nav.archive.title": "Projets archivés",
  "nav.archive.blurb": "Restaurer ou supprimer définitivement les projets archivés.",
  "nav.scaffoldRepair.title": "Réparer la structure du projet",
  "nav.scaffoldRepair.blurb": "Régénérer les fichiers de structure manquants.",
  "nav.help.title": "Guide des fonctionnalités",
  "nav.help.blurb": "Glossaire complet des fonctionnalités d'Eldrun.",
};

const it: Dict = {
  "common.back": "Indietro",
  "common.cancel": "Annulla",
  "common.remove": "Rimuovi",
  "common.loading": "Caricamento…",
  "common.default": "predefinito",

  "settings.title": "Impostazioni",
  "settings.theme": "Tema",
  "settings.language": "Lingua",
  "settings.language.help":
    "Imposta la lingua dell'interfaccia di Eldrun. Ha effetto immediato — nessun riavvio.",
  "settings.runScriptsBg": "Esegui script in background",
  "settings.claudeRemote": "Controllo remoto di Claude",
  "settings.headlessRemote": "Connessioni remote headless",
  "settings.persistLocal": "Sessioni locali persistenti (tmux)",
  "settings.energySaver": "Risparmio energetico",
  "energy.off": "Disattivato",
  "energy.battery": "A batteria",
  "energy.always": "Sempre",
  "settings.debug": "Modalità debug",
  "settings.experimental": "Sperimentale",
  "settings.agentModeToggle": "Interruttore Plan/Auto sulle schede agente",
  "settings.pythonRunDebug": "Esegui/Debug Python nel visualizzatore di codice",
  "settings.resourceMonitor": "Monitoraggio risorse",
  "settings.showCpu": "Mostra utilizzo CPU",
  "settings.showRam": "Mostra utilizzo RAM",
  "settings.showGpu": "Mostra utilizzo GPU",

  "settings.calendar": "Calendario",
  "settings.weekStartsOn": "La settimana inizia di",
  "day.sunday": "Domenica",
  "day.monday": "Lunedì",
  "settings.defaultView": "Vista predefinita",
  "view.day": "Giorno",
  "view.week": "Settimana",
  "view.multiweek": "Multisettimana",
  "view.month": "Mese",
  "view.agenda": "Agenda",
  "view.tasks": "Attività",
  "settings.clock24": "Formato 24 ore",
  "settings.dayGridStart": "La griglia del giorno inizia alle",
  "settings.defaultReminder": "Promemoria predefinito",
  "reminder.none": "Nessuno",
  "reminder.5": "5 minuti prima",
  "reminder.15": "15 minuti prima",
  "reminder.30": "30 minuti prima",
  "reminder.60": "1 ora prima",
  "reminder.1440": "1 giorno prima",

  "settings.hintsOnboarding": "Suggerimenti e introduzione",
  "settings.showHints": "Mostra suggerimenti contestuali",
  "settings.howToStart": "Come iniziare...",
  "settings.takeTour": "Fai un tour",
  "settings.lessons": "Lezioni",
  "settings.resetHints": "Reimposta suggerimenti",

  "settings.layout": "Layout",
  "settings.windowZoom": "Zoom finestra",
  "settings.minSubWidth": "Larghezza min. sottofinestra (px)",
  "settings.minSubHeight": "Altezza min. sottofinestra (px)",

  "settings.downloads": "Download",
  "settings.noDownloadFolders":
    "Nessuna cartella aggiunta — viene usata la cartella Download di sistema.",
  "settings.addDownloadFolder": "Aggiungi cartella download...",

  "settings.usageStats": "Statistiche di utilizzo",
  "settings.dailyRecap": "Mostra il riepilogo all'inizio di ogni giorno",
  "settings.openUsageStats": "Apri statistiche di utilizzo",

  "settings.moreSettings": "Altre impostazioni",
  "nav.git.title": "Hosting Git",
  "nav.git.blurb": "Profilo di hosting, token di accesso e pubblicazione.",
  "nav.vpn.title": "Connessione automatica VPN",
  "nav.vpn.blurb": "Attiva un tunnel salvato per connettersi all'avvio.",
  "nav.remoteHosts.title": "Connessioni remote",
  "nav.remoteHosts.blurb": "Imposta un percorso standard per host SSH.",
  "nav.global.title": "App globali",
  "nav.global.blurb": "Avvii della barra mostrati in ogni progetto.",
  "nav.filetypes.title": "App per tipo di file",
  "nav.filetypes.blurb": "Scegli quale app apre ogni tipo di file.",
  "nav.agents.title": "Gestisci agenti",
  "nav.agents.blurb": "Installa o aggiorna le CLI degli agenti.",
  "nav.shortcuts.title": "Scorciatoie da tastiera",
  "nav.shortcuts.blurb": "Riassegna le scorciatoie di navigazione.",
  "nav.archive.title": "Progetti archiviati",
  "nav.archive.blurb": "Ripristina o elimina definitivamente i progetti archiviati.",
  "nav.scaffoldRepair.title": "Ripara struttura del progetto",
  "nav.scaffoldRepair.blurb": "Rigenera i file di struttura mancanti.",
  "nav.help.title": "Guida alle funzioni",
  "nav.help.blurb": "Glossario completo delle funzioni di Eldrun.",
};

const TRANSLATIONS: Record<Language, Dict> = { en, de, es, fr, it };

const LANG_CACHE_KEY = "eldrun-lang";

function cachedLang(): Language {
  try {
    return normalizeLang(localStorage.getItem(LANG_CACHE_KEY));
  } catch {
    return "en";
  }
}

interface I18nStore {
  lang: Language;
  /** Set the live language WITHOUT persisting (persistence rides settings.json).
   *  Every `useT()` subscriber re-renders instantly. */
  setLangLocal: (lang: Language) => void;
}

export const useI18nStore = create<I18nStore>((set) => ({
  lang: cachedLang(),
  setLangLocal: (lang) => set({ lang }),
}));

/** Apply a language app-wide: flips the reactive store and caches it so the next
 *  launch paints this language before settings finish loading. Mirrors
 *  `applyTheme` in `stores/settings`. */
export function applyLanguage(value: string | null | undefined) {
  const lang = normalizeLang(value);
  useI18nStore.getState().setLangLocal(lang);
  try {
    localStorage.setItem(LANG_CACHE_KEY, lang);
  } catch {
    // localStorage unavailable — the switch still works this session.
  }
}

/** Look up a key in `lang`, falling back to English then the raw key. `params`
 *  substitutes `{name}` placeholders. */
export function translate(
  lang: Language,
  key: TranslationKey,
  params?: Record<string, string | number>,
): string {
  const raw = TRANSLATIONS[lang]?.[key] ?? en[key] ?? key;
  if (!params) return raw;
  return raw.replace(/\{(\w+)\}/g, (m, name) =>
    name in params ? String(params[name]) : m,
  );
}

/** The translator hook: `const t = useT(); t("settings.title")`. Re-renders the
 *  component whenever the language changes, so switching is live. */
export function useT() {
  const lang = useI18nStore((s) => s.lang);
  return useMemo(
    () =>
      (key: TranslationKey, params?: Record<string, string | number>) =>
        translate(lang, key, params),
    [lang],
  );
}

import { useT } from "../../lib/i18n";
import { stripFormatControls } from "../../lib/textSafety";
import type { MailDraft } from "../../types/mail";

/**
 * The "Drafted by agents" rail entry's list: the folder list's shape
 * (`mail-list` / `mail-row`), minus every control that acts on a server
 * message — a draft here lives in no folder. A click opens it in a composer
 * tab (`openAgentDraft`), as a click on a message opens its tab; nothing here
 * sends.
 *
 * Mail strings stay plain text nodes, as in `MailList`: the body an agent wrote
 * may carry text shaped by mail from outside.
 */
export function MailAgentDraftList({
  drafts,
  onOpen,
}: {
  drafts: MailDraft[];
  onOpen: (draft: MailDraft) => void;
}) {
  const t = useT();
  return (
    <div className="mail-list mail-agent-draft-list">
      {drafts.length === 0 && <div className="mail-empty">{t("mail.noAgentDrafts")}</div>}
      <div className="mail-list-rows">
        {drafts.map((d) => {
          const to = [...d.to, ...d.cc, ...d.bcc].map(stripFormatControls).join(", ");
          return (
            <div
              key={d.id}
              className="mail-row"
              role="button"
              tabIndex={0}
              title={t(d.origin === "reader" ? "mail.agentDraftReaderBanner" : "mail.agentDraftBanner")}
              onClick={() => onOpen(d)}
              onKeyDown={(e) => {
                if (e.key === "Enter" || e.key === " ") {
                  e.preventDefault();
                  onOpen(d);
                }
              }}
            >
              <div className="mail-agent-draft-row-top">
                <span className={`mail-agent-mark${d.origin === "reader" ? " reader" : ""}`}>
                  {t(d.origin === "reader" ? "mail.agentMarkReader" : "mail.agentMark")}
                </span>
                <span className="mail-row-from">{to || t("mail.noRecipient")}</span>
              </div>
              <div className="mail-row-subject">
                {stripFormatControls(d.subject) || t("mail.noSubject")}
              </div>
              {/* What sets this draft apart from a plain one — files the agent
                  attached, recipients it only suggested — visible before it is
                  opened. */}
              {(d.staged.length > 0 || (d.suggested_to?.length ?? 0) > 0) && (
                <div className="mail-row-preview mail-agent-draft-counts">
                  {[
                    d.staged.length > 0 ? t("mail.agentDraftAttachments", { count: d.staged.length }) : "",
                    d.suggested_to?.length ? t("mail.agentDraftSuggests", { count: d.suggested_to.length }) : "",
                  ]
                    .filter(Boolean)
                    .join(" · ")}
                </div>
              )}
              {d.body_text && (
                <div className="mail-row-preview">
                  {stripFormatControls(d.body_text.slice(0, 200))}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

// LotusPond's assistant on WhatsApp (docs/whatsapp.md). The person links their number by sending a short code from
// it to LotusPond's WhatsApp number, which proves the number is theirs. After that, messages from that number go to
// the assistant, and reports sent there are saved to the records' files for review in the app.

/** Version of the WhatsApp notice shown before linking. */
export const WHATSAPP_NOTICE_VERSION = '2026-11-11';

/** How long a link code works. */
export const WHATSAPP_CODE_MINUTES = 15;

export interface WhatsAppLink {
  /** The number, partly hidden: "+91 ••••• •3210". */
  phone: string;
  /** The profile WhatsApp works on and saves reports to. */
  profileId: string;
  linkedAt: string;
  lastMessageAt: string | null;
}

export interface WhatsAppInfo {
  /** False when the server has no WhatsApp setup, or the assistant is off. */
  enabled: boolean;
  noticeVersion: string;
  link: WhatsAppLink | null;
  /** A code waiting to be sent from WhatsApp. */
  pending: { expiresAt: string } | null;
}

/** What starting a link returns: the code and a link that opens WhatsApp with the message written. */
export interface WhatsAppLinkStart {
  code: string;
  url: string;
  /** LotusPond's number, to show ("+91 98765 43210"). */
  number: string;
  expiresAt: string;
}

/** The message the link writes for the person; the code is found anywhere in what they send. */
export const linkMessage = (code: string) => `Link my LotusPond account: ${code}`;

/** Show a number as "+91 ••••• •3210". */
export function maskPhone(digits: string): string {
  const d = digits.replace(/\D/g, '');
  const cc = d.length > 10 ? d.slice(0, d.length - 10) : '';
  const tail = d.slice(-4);
  return `${cc ? `+${cc} ` : ''}••••• •${tail}`;
}

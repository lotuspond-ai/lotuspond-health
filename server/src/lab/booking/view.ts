// What the API shows of an order: no personal details (the app already has them) and no internal fields.
import type { LabOrderView, OrderStatus } from '../../../../shared/lab-bundle.ts';
import { canCancel, canReschedule } from '../orders/state.ts';
import type { OrderEvent, OrderRecord } from '../store/types.ts';
import { istIso } from '../time.ts';

export type OrderView = LabOrderView;

export function orderView(o: OrderRecord, events?: OrderEvent[]): OrderView {
  const view: OrderView = {
    id: o.id,
    profileId: o.profileId,
    partner: o.partner,
    partnerRef: o.partnerRef,
    status: o.status,
    items: o.items,
    slot: o.slotStart != null && o.slotEnd != null ? { start: istIso(o.slotStart), end: istIso(o.slotEnd) } : null,
    pricePaise: o.pricePaise,
    payer: o.payer,
    failureReason: o.failureReason,
    canCancel: canCancel(o.status),
    canReschedule: canReschedule(o.status),
    createdAt: istIso(o.createdAt),
    updatedAt: istIso(o.updatedAt),
  };
  if (events) {
    const timeline: { status: OrderStatus; at: string }[] = [];
    for (const e of events) {
      if (timeline.length && timeline[timeline.length - 1].status === e.status) continue;
      timeline.push({ status: e.status, at: istIso(e.occurredAt ?? e.receivedAt) });
    }
    view.timeline = timeline;
  }
  return view;
}

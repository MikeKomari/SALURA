import { compareDeliveryTool, draftStaffQueryTool, proposeInvoiceAdjustmentTool, readDeliveryDocument } from './delivery-tools.ts';
import {
  cancelOrderTool,
  checkCredit,
  checkStock,
  confirmOrderTool,
  draftOrderTool,
  escalateToHuman,
  getCustomerProfile,
  readOrderImage,
  recordPromiseToPayTool,
  requestApprovalTool,
  searchCatalogTool,
  searchPolicies,
  splitOrderTool,
  transcribeAudio,
} from './order-tools.ts';
import { recordPayment, reportDeliveryProblem } from './support-tools.ts';
import type { ToolDef } from './types.ts';

/** Everything the agent answering a customer's chat may use. */
export const ORDER_TOOLS: ToolDef[] = [
  getCustomerProfile,
  transcribeAudio,
  readOrderImage,
  searchCatalogTool,
  checkStock,
  checkCredit,
  draftOrderTool,
  confirmOrderTool,
  splitOrderTool,
  requestApprovalTool,
  cancelOrderTool,
  recordPromiseToPayTool,
  recordPayment,
  reportDeliveryProblem,
  readDeliveryDocument,
  compareDeliveryTool,
  draftStaffQueryTool,
  proposeInvoiceAdjustmentTool,
  searchPolicies,
  escalateToHuman,
] as ToolDef[];

import {
  observeWithReferenceObserver
} from "../observer/referenceObserver.js";
import {
  validateAdapterContract,
  type AdapterContract,
  type ObserverAdapter
} from "./sdk.js";

export function createReferenceObserverAdapter(
  contract: AdapterContract
): ObserverAdapter {
  validateAdapterContract(contract);
  if (contract.kind !== "observer") {
    throw new Error(
      "Reference Observer requires an Observer Adapter contract."
    );
  }
  return {
    contract,
    observe: observeWithReferenceObserver
  };
}

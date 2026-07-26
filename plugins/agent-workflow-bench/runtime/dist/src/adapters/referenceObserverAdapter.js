import { observeWithReferenceObserver } from "../observer/referenceObserver.js";
import { validateAdapterContract } from "./sdk.js";
export function createReferenceObserverAdapter(contract) {
    validateAdapterContract(contract);
    if (contract.kind !== "observer") {
        throw new Error("Reference Observer requires an Observer Adapter contract.");
    }
    return {
        contract,
        observe: observeWithReferenceObserver
    };
}

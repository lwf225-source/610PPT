// Local execution needs no cloud account or gateway.
export const cloudMode = () => false;
export const assertCloudApiUrl = () => {};
export const resolveCloudStoredPath = () => { throw new Error('Cloud storage is unavailable in the local runtime'); };
export const readCloudDeviceStatus = async () => { throw new Error('Cloud connector is unavailable in the local runtime'); };

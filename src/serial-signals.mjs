const uartBridgeVendors = new Set([
  0x0403, // FTDI
  0x10c4, // Silicon Labs CP210x
  0x1a86, // WCH CH34x / CH91xx
]);

export function isKnownUartBridge(port) {
  return uartBridgeVendors.has(port.getInfo?.()?.usbVendorId);
}

export function releaseSerialControlLines(port) {
  return port.setSignals?.({ dataTerminalReady: false, requestToSend: false });
}

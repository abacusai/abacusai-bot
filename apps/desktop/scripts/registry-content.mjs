/** RSC directives have no meaning in this rsc:false desktop renderer. */
export const registryContent = (source, rsc) =>
  rsc ? source : source.replace(/^(["'])use client\1;\r?\n(?:\r?\n)?/, "");

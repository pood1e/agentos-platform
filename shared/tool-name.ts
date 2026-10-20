export const toolBaseName = (name: string) => name.split(/__|\./).at(-1) ?? name;

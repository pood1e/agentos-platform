import { useSearchParams } from "react-router";

/** One URL query parameter, replaced in place; an empty value removes it. */
export function useSearchParam(key: string): [string, (value: string) => void] {
  const [params, setParams] = useSearchParams();
  const set = (value: string) =>
    setParams(
      (current) => {
        const next = new URLSearchParams(current);
        if (value) next.set(key, value);
        else next.delete(key);
        return next;
      },
      { replace: true },
    );
  return [params.get(key) ?? "", set];
}

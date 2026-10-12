import { useMutation, useQueryClient } from '@tanstack/react-query';

/**
 * Mutation wrapper that standardizes cache invalidation (spec 7.2).
 *
 * Usage:
 *   useApiMutation((data) => itemsApi.create(data), {
 *     invalidates: [qk.items.root, qk.stock.root],
 *   });
 *
 * `invalidates` accepts query keys or functions of the mutation variables
 * that return a query key.
 *
 * @param {(variables: any) => Promise<any>} mutationFn
 * @param {{ invalidates?: Array<object | ((vars: any) => object)>, onSuccess?: Function, onError?: Function, [key: string]: any }} [options]
 */
export function useApiMutation(mutationFn, options = {}) {
  const queryClient = useQueryClient();
  const { invalidates = [], onSuccess, onError, ...rest } = options;

  return useMutation({
    mutationFn,
    ...rest,
    onSuccess(data, variables, context) {
      invalidates.forEach((entry) => {
        const key = typeof entry === 'function' ? entry(variables) : entry;
        queryClient.invalidateQueries({ queryKey: key });
      });
      if (onSuccess) onSuccess(data, variables, context);
    },
    onError(error, variables, context) {
      if (onError) onError(error, variables, context);
    },
  });
}

export default useApiMutation;

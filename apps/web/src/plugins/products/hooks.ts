'use client'

// Products plugin — Firestore CRUD for a team's sellable products.
// Catalog lives at teams/{teamId}/products/{productId}; the public storefront
// reads the world-readable public_profile summary (synced by a Cloud Function).

import { useQuery } from '@tanstack/react-query'
import {
  collection,
  doc,
  getDocs,
  query,
  orderBy,
  setDoc,
  updateDoc,
  deleteDoc,
  serverTimestamp,
  getCountFromServer,
} from 'firebase/firestore'
import { db } from '@/lib/firebase'
import { TEAMS_COLLECTION, PRODUCTS_SUBCOLLECTION } from '@linyup/shared'
import type { Product } from '@linyup/shared'

function productsCol(teamId: string) {
  return collection(db, TEAMS_COLLECTION, teamId, PRODUCTS_SUBCOLLECTION)
}

export function useProducts(teamId: string | null) {
  return useQuery<Product[]>({
    queryKey: ['products', teamId],
    enabled: !!teamId,
    queryFn: async () => {
      const snap = await getDocs(query(productsCol(teamId!), orderBy('created_at', 'desc')))
      return snap.docs.map((d) => ({ id: d.id, ...(d.data() as Omit<Product, 'id'>) }))
    },
  })
}

export type ProductInput = Pick<
  Product,
  | 'name'
  | 'description'
  | 'imageUrl'
  | 'priceAmount'
  | 'variantLabel'
  | 'variants'
  | 'active'
  | 'order'
  // How the buyer gets it (UX-79). Written as '' rather than dropped when the
  // studio clears it, so an emptied field falls back to the TEAM default instead
  // of keeping the stale per-product sentence — see resolveProductCollectionNote.
  | 'collectionNote'
>

export async function createProduct(input: {
  teamId: string
  userId: string
  data: ProductInput
}): Promise<string> {
  const ref = doc(productsCol(input.teamId))
  await setDoc(ref, {
    teamId: input.teamId,
    active: true,
    ...stripUndefined(input.data),
    created_at: serverTimestamp(),
    updated_at: serverTimestamp(),
    createdBy: input.userId,
  })
  return ref.id
}

export async function updateProduct(
  teamId: string,
  productId: string,
  patch: Partial<ProductInput>
): Promise<void> {
  await updateDoc(doc(productsCol(teamId), productId), {
    ...stripUndefined(patch),
    updated_at: serverTimestamp(),
  })
}

export async function deleteProduct(teamId: string, productId: string): Promise<void> {
  await deleteDoc(doc(productsCol(teamId), productId))
}

// Live product count — enforces the per-team catalog cap even when the cached
// list query is stale.
export async function countProducts(teamId: string): Promise<number> {
  const snap = await getCountFromServer(productsCol(teamId))
  return snap.data().count
}

// Firestore rejects `undefined` field values; drop them before writing.
function stripUndefined<T extends Record<string, unknown>>(obj: T): Partial<T> {
  return Object.fromEntries(Object.entries(obj).filter(([, v]) => v !== undefined)) as Partial<T>
}

import { storeToRefs } from 'pinia'
import { useFamilyStore } from '@/stores/familyStore'

export function useFamily() {
  const store = useFamilyStore()
  return { ...storeToRefs(store), hydrate: store.hydrate, getById: store.getById, relations: store.relations, addMember: store.addMember, updateMember: store.updateMember, importMembers: store.importMembers, removeMember: store.removeMember }
}

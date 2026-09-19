<template>
  <section v-if="member" class="detail-page">
    <div class="profile-hero">
      <MemberAvatar :member="member" size="lg" :deceased="Boolean(member.deathDate)" />
      <div>
        <p>成员档案</p>
        <h1>{{ member.name }}</h1>
        <span>{{ genderLabels[member.gender] }} · {{ lifeYears(member) }} · {{ member.birthPlace || '籍贯未知' }}</span>
      </div>
    </div>
    <n-grid :cols="2" :x-gap="18" :y-gap="18" responsive="screen">
      <n-gi>
        <section class="panel"><h2>个人简介</h2><p>{{ member.bio }}</p></section>
        <section class="panel">
          <h2>关联成员</h2>
          <div class="relation-row">
            <span class="relation-label">父母</span>
            <template v-if="relationSummary.parents.length">
              <RouterLink v-for="item in relationSummary.parents" :key="item.id" class="relation-link" :to="`/members/${item.id}`">{{ item.name }}</RouterLink>
            </template>
            <span v-else class="relation-empty">未记录</span>
          </div>
          <div class="relation-row">
            <span class="relation-label">配偶</span>
            <template v-if="relationSummary.spouses.length">
              <RouterLink v-for="item in relationSummary.spouses" :key="item.id" class="relation-link" :to="`/members/${item.id}`">{{ item.name }}</RouterLink>
            </template>
            <span v-else class="relation-empty">未记录</span>
          </div>
          <div class="relation-row">
            <span class="relation-label">子女</span>
            <template v-if="relationSummary.children.length">
              <RouterLink v-for="item in relationSummary.children" :key="item.id" class="relation-link" :to="`/members/${item.id}`">{{ item.name }}</RouterLink>
            </template>
            <span v-else class="relation-empty">未记录</span>
          </div>
        </section>
      </n-gi>
      <n-gi>
        <section class="panel"><h2>家族故事</h2><TimelineView :items="storyItems" /></section>
      </n-gi>
    </n-grid>
    <section class="panel"><h2>老照片</h2><MediaGallery :items="galleryItems" /></section>
    <section class="panel"><h2>遗产规划</h2><n-list><n-list-item v-for="plan in memberPlans" :key="plan.id">{{ legacyTypeLabels[plan.type] }} · {{ plan.status }} · {{ plan.content }}</n-list-item></n-list></section>
  </section>
  <EmptyState v-else title="成员不存在" description="请回到家谱树选择一个有效成员。" />
</template>

<script setup lang="ts">
import { computed, onMounted } from 'vue'
import { useRoute } from 'vue-router'
import MemberAvatar from '@/components/common/MemberAvatar.vue'
import TimelineView from '@/components/common/TimelineView.vue'
import MediaGallery from '@/components/common/MediaGallery.vue'
import EmptyState from '@/components/common/EmptyState.vue'
import { useFamily } from '@/hooks/useFamily'
import { useStory } from '@/hooks/useStory'
import { usePhoto } from '@/hooks/usePhoto'
import { useLegacyStore } from '@/stores/legacyStore'
import { genderLabels, legacyTypeLabels } from '@/constants/enums'
import { lifeYears } from '@/utils/member-status'

const route = useRoute()
const { hydrate, getById, relations } = useFamily()
const story = useStory()
const photo = usePhoto()
const legacy = useLegacyStore()
const member = computed(() => getById(String(route.params.id)))
const relationSummary = computed(() => relations(String(route.params.id)))
const storyItems = computed(() => story.byMember(String(route.params.id)).map((item) => ({ id: item.id, title: item.title, description: item.content, date: item.date })))
const galleryItems = computed(() => photo.byMember(String(route.params.id)).map((item) => ({ id: item.id, url: item.restoredUrl || item.imageUrl, caption: item.caption, year: item.year, meta: item.location })))
const memberPlans = computed(() => legacy.byMember(String(route.params.id)))

onMounted(async () => {
  await Promise.all([hydrate(), story.hydrate(), photo.hydrate(), legacy.hydrate()])
})
</script>

<style scoped>
.relation-row {
  display: flex;
  align-items: baseline;
  flex-wrap: wrap;
  gap: 8px 12px;
  margin: 8px 0;
}

.relation-label {
  min-width: 36px;
  color: #6b7c72;
  font-size: 14px;
}

.relation-link {
  color: #395346;
  font-weight: 600;
  border-bottom: 1px dashed rgba(57, 83, 70, 0.5);
}

.relation-link:hover {
  color: #24352d;
  border-bottom-style: solid;
}

.relation-empty {
  color: #9aa69e;
}
</style>

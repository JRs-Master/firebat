---
name: exam-to-quiz
kind: tool-usage
description: 라이브러리 시험지 PDF → 퀴즈 렌더. 태그 - 시험지, 문제지, 기출, 퀴즈로, 문제 풀기, exam, quiz, 객관식, 보기. 라이브러리에 올린 시험지/문제지를 문항·보기로 구조화해 quiz_group 으로 보여줄 때 get_skill 로 본문을 읽고 그대로 따를 것.
---

# 라이브러리 시험지 → quiz 렌더 (library_extract_structured)

시험지는 2단·보기 그리드라 텍스트 파싱(Document Parse)은 reading-order 가 꼬여 보기 순서가
틀린다. **`library_extract_structured`(Upstage 정보추출)** 는 스키마 대비 의미 추출이라 문항↔보기
귀속이 구조적이다 — 시험지는 항상 이 도구를 쓴다(search_library 로 본문을 긁어 조립하지 말 것).

## 절차

1. **소스 찾기** — `search_library` 로 그 시험지를 검색(과목·연도·"시험" 등) → 결과의 `source_id`.
   (사용자가 파일명을 주면 그 내용 키워드로 검색해 해당 소스를 특정.)
2. **구조화** — `library_extract_structured({ sourceId, schema })` 를 아래 표준 스키마로 호출.
   여러 문항이 한 지문/대화를 공유하면 `passage` 에 담긴다.

   ```json
   { "type": "object", "properties": {
       "questions": { "type": "array", "items": { "type": "object", "properties": {
         "number":  { "type": "string", "description": "문항 번호" },
         "passage": { "type": "string", "description": "이 문항이 딸린 지문/대화문(있을 때만)" },
         "stem":    { "type": "string", "description": "문제 문장(빈칸 __ 포함, 밑줄·지시문 포함)" },
         "choices": { "type": "array", "items": { "type": "string" }, "description": "보기 4~5개, 번호표 제외한 텍스트만, 원 순서 유지" }
       } } }
   } }
   ```

3. **렌더** — 반환 `questions` 를 `quiz_group` 으로. 매핑: `stem`→`question`, `choices`→`choices`,
   `number`→`number`. 지문 공유 묶음은 그 지문을 quiz_group 의 `passage` 로 두고 문항을 함께 넣는다
   (지문마다 quiz_group 하나). 문항 수가 많으면 대단원별로 여러 fence 로 나눠도 된다.

## 정답(answer) 규칙

- **문제지에는 정답이 없다** — 시험지 PDF 만 구조화하면 `answer` 는 넣지 말 것(보기만 표시 =
  풀이용). 정답을 **지어내지 말 것**(모델이 푼 답 ≠ 공식 정답).
- 사용자가 **정답표(답안지) PDF 를 따로 올렸으면** 그것도 구조화해 문항 번호로 매칭 → `quiz_group`
  각 문항의 `answer`(정답 텍스트) 또는 `answerIndex`(0-based) 를 채운다(그때만 자동 채점 동작).

## 주의

- `library_extract_structured` 는 라이브러리 업로드 문서 전용(sourceId 필요). 라이브러리 밖 문서는
  대상이 아니다.
- 보기 텍스트는 원 순서 그대로(스키마가 순서를 보존). 번호(①②③④)는 컴포넌트가 자동으로 붙이니
  `choices` 텍스트에 원 번호를 넣지 말 것(중복 표기 방지).
